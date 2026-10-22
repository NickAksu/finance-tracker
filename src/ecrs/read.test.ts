import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import writerWasm from "zxing-wasm/writer/zxing_writer.wasm";
import { describe, expect, it } from "vitest";
import { readEcrsUid } from "./read";
import { zxingOverrides } from "./wasm";

describe("чтение QR", () => {
  it("находит ссылку на электронный чек", async () => {
    await prepareZXingModule({ fireImmediately: true, overrides: zxingOverrides(writerWasm) });
    const written = await writeBarcode("https://mch.ecrs.by/396DA58C6F9C99BF071931BD", { format: "QRCode", scale: 4 });
    expect(written.error).toBe("");
    expect(written.image).toBeTruthy();
    const data = await written.image!.arrayBuffer();
    const uid = await readEcrsUid([{ data, mime: "image/png" }]);
    expect(uid).toBe("396DA58C6F9C99BF071931BD");
  });
});
