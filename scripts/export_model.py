# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["ultralytics", "onnx", "onnxslim", "onnxruntime"]
# ///
"""Export an Ultralytics YOLO model to ONNX for the browser app.

Supports object detection models and semantic segmentation models (used for walls).

The exported file lands in public/models/ and is registered in
public/models/manifest.json, which the app reads at startup. No app code
changes are needed to add a model.

Usage:
    uv run scripts/export_model.py yolo26n
    uv run scripts/export_model.py yolo26s yolo26m
    uv run scripts/export_model.py yolo26n-sem-ade20k --label "YOLO26n-sem (ADE20K)"
    uv run scripts/export_model.py yolo27n          # once YOLO27 weights are published
    uv run scripts/export_model.py runs/detect/train/weights/best.pt --id parts --label "Parts detector"
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path

import onnx
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "public" / "models"
MANIFEST = MODELS_DIR / "manifest.json"
WEIGHTS_DIR = ROOT / ".weights"  # where Ultralytics downloads named checkpoints
SUPPORTED_TASKS = ("detect", "semantic")


def pretty_label(stem: str) -> str:
    # "yolo26n" -> "YOLO26n"
    return "YOLO" + stem[4:] if stem.lower().startswith("yolo") else stem


def output_format(onnx_path: Path, num_classes: int) -> str:
    output = onnx.load(onnx_path).graph.output[0].type.tensor_type
    dims = [d.dim_value for d in output.shape.dim]
    if len(dims) == 3 and output.elem_type == onnx.TensorProto.UINT8:
        return "labelmap"  # [1, H, W] = class id per pixel (semantic segmentation, argmax in-graph)
    if len(dims) == 3 and dims[2] == 6:
        return "end2end"  # [1, max_det, 6] = x1, y1, x2, y2, score, class (NMS-free)
    if len(dims) == 3 and dims[1] == 4 + num_classes:
        return "raw"  # [1, 4 + nc, anchors] = cx, cy, w, h, class scores (needs NMS)
    raise SystemExit(f"Unsupported output shape {dims} in {onnx_path.name}")


def export(weights: str, model_id: str | None, label: str | None, imgsz: int) -> dict:
    model = YOLO(weights)
    if model.task not in SUPPORTED_TASKS:
        raise SystemExit(
            f"{weights} is a '{model.task}' model. The web app renders {' and '.join(SUPPORTED_TASKS)} models."
        )

    # nms=False selects the NMS-free (one-to-one) head on models that have one, such as YOLO26.
    exported = Path(model.export(format="onnx", imgsz=imgsz, simplify=True, nms=False))
    stem = model_id or Path(weights).stem
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    target = MODELS_DIR / f"{stem}.onnx"
    shutil.move(str(exported), target)

    names = [model.names[i] for i in sorted(model.names)]
    return {
        "id": stem,
        "label": label or pretty_label(stem),
        "file": target.name,
        "imgsz": imgsz,
        "task": model.task,
        "format": output_format(target, len(names)),
        "bytes": target.stat().st_size,
        "names": names,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("weights", nargs="+", help="Ultralytics model name (e.g. yolo26n) or path to a .pt file")
    parser.add_argument("--id", help="Model id and file name (single model only)")
    parser.add_argument("--label", help="Name shown in the app (single model only)")
    parser.add_argument("--imgsz", type=int, default=640)
    args = parser.parse_args()
    if len(args.weights) > 1 and (args.id or args.label):
        parser.error("--id and --label only apply when exporting a single model")

    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {"models": []}
    weights_list = [str(Path(w).resolve()) if Path(w).exists() else (w if w.endswith(".pt") else w + ".pt") for w in args.weights]
    WEIGHTS_DIR.mkdir(exist_ok=True)
    os.chdir(WEIGHTS_DIR)
    for weights in weights_list:
        entry = export(weights, args.id, args.label, args.imgsz)
        manifest["models"] = [m for m in manifest["models"] if m["id"] != entry["id"]] + [entry]
        print(f"Added {entry['label']} ({entry['format']}, {entry['bytes'] / 1e6:.1f} MB) -> public/models/{entry['file']}")

    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
