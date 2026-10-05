# Still — private AI object remover

A personal, browser-first photo editor built with Next.js, TypeScript, Tailwind CSS, ONNX Runtime Web, and LaMa. There is no account system, database, image API, analytics, or image storage.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Next.js. Before the first removal, the browser downloads the LaMa model (about 208 MB). ONNX Runtime and the model are cached by the browser where storage permits. Later visits can reuse the cached files.

## Image privacy

Image decoding, mask creation, inference, comparison, and export all happen in the browser. The photo and mask are passed only to a same-origin Web Worker; they are never posted to a server. The default external request is a public, version-pinned model file hosted by Hugging Face. No API key is used, and no image is sent to Hugging Face. A successful export is created as a temporary browser object URL and exists only in the tab until downloaded.

To use a different model host, set `NEXT_PUBLIC_LAMA_MODEL_URL` to a CORS-enabled URL for a compatible LaMa ONNX file. This is a public asset URL, not a secret. For strict offline/self-hosted use, download the model yourself and point this variable at the asset you serve. The selected 208 MB FP32 model is intentionally not committed here: large static artifacts are unsuitable for this small source repository, and Vercel's deployment/file limits make bundling it there impractical. The default public model host is therefore needed for the first model download unless you configure your own host.

## Model/runtime decision

The browser-side options were evaluated before implementation:

- **LaMa (big-lama) FP32 ONNX** was selected for its strong large-mask object removal, Apache-2.0 release, and fixed 512 × 512 inference shape. The app crops larger selections into overlapping 512 px inputs and only composites the selected mask, keeping pixels outside it at the source resolution. Large images are bounded to a 2048 px working edge and restored into a high-resolution export where the device has enough memory.
- **ONNX Runtime Web** runs the ONNX graph directly. The app tries WebGPU first and falls back to WebAssembly if WebGPU is unavailable or the model fails on it. Inference runs in a dedicated Worker so the editor remains interactive. Browser WebGPU operator coverage varies, so the CPU/WASM path remains important.
- A smaller quantized LaMa export (about 93 MB) was also considered. It was not selected for this first build because its browser-runtime operator compatibility and quality trade-off are not validated here; quality takes priority over reducing the first download. See the [OpenCV LaMa export](https://huggingface.co/opencv/inpainting_lama) for that alternative.
- **Transformers.js** was not selected: it is a useful high-level wrapper for supported pipelines, but it does not provide a native LaMa/inpainting pipeline for this model. Calling ONNX Runtime directly is the smaller, more explicit route for LaMa.
- **Diffusion inpainting models** can offer stronger semantic reconstruction, but practical browser builds generally require much larger model bundles and memory than this privacy-first, mobile-capable first phase can reasonably assume. This implementation makes no promise of perfect anatomy or plausible results for every image; inspect the before/after result and refine the mask when needed.

LaMa's 512 × 512 input and roughly 208 MB FP32 weights are real constraints. First use requires a substantial download, CPU fallback may take several seconds per crop, and memory-limited phones can fail gracefully. A very large selection is split into smaller passes; images too large to process safely should be resized before upload.

## Deploy to Vercel

1. Push this repository to GitHub.
2. Import it into Vercel as a Next.js project.
3. Use the standard install/build settings (`npm install`, `npm run build`). No backend environment variables or secrets are required.

`NEXT_PUBLIC_LAMA_MODEL_URL` is optional and only changes where public model weights are fetched. The app is marked `noindex` and `robots.txt` disallows crawling.

## References

- [LaMa / ONNX model card](https://huggingface.co/Carve/LaMa-ONNX)
- [LaMa paper and reference implementation](https://github.com/advimman/lama)
- [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)
- [ONNX Runtime WebGPU provider notes](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
- [Transformers.js model and task support](https://huggingface.co/docs/transformers.js/en/index)

## Checks

```bash
npm run typecheck
npm run build
```
