# yooolo

Real-time object and wall detection with Ultralytics YOLO26, running entirely in the browser.
Camera frames and images never leave the device.

- **Objects**: YOLO26n or YOLO26s (COCO, 80 classes), NMS-free head.
- **Walls**: YOLO26n-sem (ADE20K semantic segmentation). The `wall` class is drawn as a yellow mask, with a coverage readout.
- **Engine**: ONNX Runtime Web on WebGPU, falling back to multi-threaded WebAssembly.

YOLO27 isn't published yet (Ultralytics' page is a waitlist). It keeps the same interface as YOLO26, so when the
weights are released, export them with the script below and they appear in the app with no code changes.

## Run it 

```sh
npm install
npm run dev        # http://localhost:5173
```

The camera needs a secure origin: `localhost` works, and so does any HTTPS deployment.

## Add or update models

`scripts/export_model.py` exports any Ultralytics detection or semantic-segmentation model to ONNX, copies it to
`public/models/`, and registers it in `public/models/manifest.json`. It declares its own dependencies, so
[uv](https://docs.astral.sh/uv/) is all you need:

```sh
uv run scripts/export_model.py yolo26n yolo26s                                  # object models
uv run scripts/export_model.py yolo26s-sem-ade20k --label "YOLO26s-sem (ADE20K)"  # a sharper wall model
uv run scripts/export_model.py yolo27n                                         # once YOLO27 is released
uv run scripts/export_model.py path/to/best.pt --id parts --label "Parts"      # your own trained model
```

The app uses the first semantic model in the manifest whose classes include `wall`.

## How it works

```
src/yolo/            framework-agnostic; copy it into any web app
  model.ts           YoloModel: one model in its own Web Worker. load(), run(video | image | canvas)
  worker.ts          ONNX Runtime session, letterbox preprocessing, output decoding
  postprocess.ts     letterbox math, NMS-free and classic (NMS) box decoding, label-map cropping
  draw.ts            wall mask and box rendering, wall coverage
src/Viewport.tsx     camera and image loops; each model runs in its own loop
src/App.tsx          model loading, settings, readouts
```

On live video, the object model runs on every frame and sets the frame rate. The wall model updates at most four
times a second, since walls barely move between frames.

## Deploy

The build is a static site (`npm run build` → `dist/`), so it can go on any static host. Two things matter:

1. **HTTPS**, or the browser won't allow camera access.
2. **Cross-origin isolation headers**, so ONNX Runtime can use multi-threaded WebAssembly. Without them the app
   still works, but CPU inference runs on a single thread:

   ```
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

### Vercel (configured)

`vercel.ts` already sets the headers above, along with cache rules for the hashed assets and the models.

```sh
npm i -g vercel
vercel login
vercel             # preview deployment
vercel --prod      # production
```

### Other hosts

- **Netlify / Cloudflare Pages**: build command `npm run build`, output directory `dist`. Add the two headers in a
  `public/_headers` file under `/*`.
- **GitHub Pages**: works, but it can't set headers, so CPU inference is single-threaded (WebGPU is unaffected).

## Licensing

Ultralytics YOLO models are AGPL-3.0. Serving them in a public web app means the app's source must be released under
AGPL-3.0 too, unless you have an [Ultralytics Enterprise License](https://www.ultralytics.com/license).

## Credits

- `public/samples/room.jpg`: "Living room in apartment of Condomínio do Edifício Zaher, Le Blond, Rio de Janeiro,
  Brazil", Wikimedia Commons, CC0.
- `public/samples/bus.jpg`: Ultralytics sample image.
