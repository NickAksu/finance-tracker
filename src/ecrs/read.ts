import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import readerWasm from "zxing-wasm/reader/zxing_reader.wasm";
import { ecrsUidFromTexts } from "../domain/ecrs";
import { zxingOverrides } from "./wasm";

let ready: Promise<void> | null = null;

function ensureReader(): Promise<void> {
  if (!ready) {
    ready = Promise.resolve(prepareZXingModule({ fireImmediately: true, overrides: zxingOverrides(readerWasm) }))
      .then(() => undefined)
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

/** Ищет на фото QR mch.ecrs.by. PDF и прочие файлы пропускает. Ошибка декодера не роняет чек. */
export async function readEcrsUid(files: readonly { data: ArrayBuffer; mime: string }[]): Promise<string | null> {
  const images = files.filter((file) => file.mime.startsWith("image/"));
  if (images.length === 0) return null;
  await ensureReader();
  for (const image of images) {
    try {
      const codes = await readBarcodes(new Blob([image.data], { type: image.mime }), {
        formats: ["QRCode"],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
      });
      const uid = ecrsUidFromTexts(codes.map((code) => code.text));
      if (uid) return uid;
    } catch (error) {
      console.warn("qr decode failed", error);
    }
  }
  return null;
}
