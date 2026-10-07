# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["ultralytics", "onnx", "onnxslim", "onnxruntime"]
# ///
"""Make the hazard detector: YOLO-World with its vocabulary fixed to trip hazards.

YOLO-World detects whatever classes it's given as text, so potholes and ladders need no training
data. Fixing the classes bakes them into the weights, giving an ordinary detector that
export_model.py can convert for the browser:

    uv run scripts/make_hazard_model.py
    uv run scripts/make_hazard_model.py pothole ladder "open manhole"   # a different vocabulary

It writes .weights/hazards.pt, then exports it as a hazard model, which runs alongside the
object model and is announced during navigation.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS_DIR = ROOT / ".weights"
DEFAULT_CLASSES = ["pothole", "ladder"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("classes", nargs="*", default=DEFAULT_CLASSES, help="what to detect, as text")
    parser.add_argument("--base", default="yolov8s-worldv2.pt", help="YOLO-World checkpoint to start from")
    args = parser.parse_args()

    WEIGHTS_DIR.mkdir(exist_ok=True)
    os.chdir(WEIGHTS_DIR)  # Ultralytics downloads named checkpoints into the working directory
    model = YOLO(args.base)
    model.set_classes(args.classes)
    target = WEIGHTS_DIR / "hazards.pt"
    model.save(str(target))
    print(f"Saved {target} detecting: {', '.join(args.classes)}")

    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "export_model.py"), str(target), "--id", "hazards", "--label", "Hazards", "--role", "hazard"],
        check=True,
    )


if __name__ == "__main__":
    main()
