import { concat, be16, makePacket, parsePacket, pathName, pathField, parseDirectoryEntry } from "./protocol.mjs";

const TI_VENDOR_ID = 0x0451;
const PRODUCT_CLASSIC_CX = 0xe012;
const PRODUCT_CX_II = 0xe022;
const FILE_SERVICE = 0x4060;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const USB_TIMEOUT_MS = 12000;

export async function listTiDevices(webUsb) {
  const devices = await webUsb.getDevices();
  return devices
    .filter(device => device.vendorId === TI_VENDOR_ID &&
      [PRODUCT_CLASSIC_CX, PRODUCT_CX_II].includes(device.productId))
    .map((device, index) => ({
      index,
      vendorId: device.vendorId,
      productId: device.productId,
      model: device.productId === PRODUCT_CLASSIC_CX ? "TI-Nspire CX / classic family" : "TI-Nspire CX II (detected; not enabled in this release)",
      supported: device.productId === PRODUCT_CLASSIC_CX,
      productName: device.productName || null,
      manufacturerName: device.manufacturerName || null
    }));
}

export class NspireFileReader {
  constructor(device) {
    if (device.vendorId !== TI_VENDOR_ID || device.productId !== PRODUCT_CLASSIC_CX) {
      throw new Error("This release supports only classic TI-Nspire CX USB device 0451:e012. No fallback or reset was attempted.");
    }
    this.device = device;
    this.interfaceNumber = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.outPacketSize = 64;
    this.hostSid = 0x4003;
    this.deviceSid = 0x4003;
    this.sequence = 1;
    this.initialized = false;
    this.opened = false;
    this.connected = false;
    this.activeService = false;
    this.busy = false;
    this.broken = false;
    this.readBuffer = new Uint8Array(0);
    this.queue = [];
    this.timeoutMs = USB_TIMEOUT_MS;
  }

  async connect() {
    if (this.opened) throw new Error("A TI-Nspire USB session is already open.");
    try {
      await this.device.open();
      if (!this.device.configuration) await this.device.selectConfiguration(1);

      const candidates = (this.device.configuration?.interfaces || [])
        .flatMap(iface => (iface.alternates || []).map(alternate => ({ iface, alternate })))
        .filter(({ alternate }) =>
          alternate.endpoints?.some(endpoint => endpoint.type === "bulk" && endpoint.direction === "in") &&
          alternate.endpoints?.some(endpoint => endpoint.type === "bulk" && endpoint.direction === "out"));

      if (!candidates.length) throw new Error("The calculator does not expose bulk USB endpoints.");
      const { iface, alternate } = candidates[0];
      this.interfaceNumber = iface.interfaceNumber;
      await this.device.claimInterface(this.interfaceNumber);
      if (alternate.alternateSetting) {
        await this.device.selectAlternateInterface(this.interfaceNumber, alternate.alternateSetting);
      }
      const inEndpoint = alternate.endpoints.find(endpoint => endpoint.type === "bulk" && endpoint.direction === "in");
      const outEndpoint = alternate.endpoints.find(endpoint => endpoint.type === "bulk" && endpoint.direction === "out");
      this.endpointIn = inEndpoint.endpointNumber;
      this.endpointOut = outEndpoint.endpointNumber;
      this.outPacketSize = outEndpoint.packetSize || 64;
      this.opened = true;

      // Intentionally do not call USBDevice.reset(). We only accept the normal
      // address request already emitted by the calculator after USB attach.
      await this.initialize();
      const root = await this.listDirectory("/");
      this.connected = true;
      return root;
    } catch (error) {
      await this.close().catch(() => {});
      throw new Error(`TI-Nspire connection failed: ${error.message}. This safe build does not reset the USB device or try live screen capture.`);
    }
  }

  async close() {
    this.connected = false;
    if (this.opened && this.activeService && !this.broken) {
      try { await this.disconnectService(); } catch { /* closing the handle is the recovery path */ }
    }
    this.activeService = false;
    this.initialized = false;
    this.queue = [];
    this.readBuffer = new Uint8Array(0);
    if (this.device.opened) {
      try { await this.device.close(); } finally { this.opened = false; }
    } else {
      this.opened = false;
    }
  }

  async withTimeout(operation, limit = this.timeoutMs) {
    if (this.broken) throw new Error("USB handle is no longer usable; disconnect and reconnect the calculator.");
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("USB transfer timed out.")), limit);
        })
      ]);
    } catch (error) {
      this.broken = true;
      this.connected = false;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async write(bytes) {
    const result = await this.withTimeout(() => this.device.transferOut(this.endpointOut, bytes));
    if (result.status !== "ok") throw new Error(`USB OUT transfer failed (${result.status}).`);
    if (bytes.length > 0 && bytes.length % this.outPacketSize === 0) {
      const zlp = await this.withTimeout(() => this.device.transferOut(this.endpointOut, new Uint8Array(0)));
      if (zlp.status !== "ok") throw new Error("USB zero-length packet terminator failed.");
    }
  }

  async readExact(count) {
    while (this.readBuffer.length < count) {
      const response = await this.withTimeout(() =>
        this.device.transferIn(this.endpointIn, Math.max(512, count - this.readBuffer.length)));
      if (response.status !== "ok" || !response.data?.byteLength) {
        throw new Error("The calculator returned no USB data.");
      }
      const part = new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength);
      this.readBuffer = concat(this.readBuffer, part);
    }
    const result = this.readBuffer.slice(0, count);
    this.readBuffer = this.readBuffer.slice(count);
    return result;
  }

  async receiveRawPacket() {
    const header = await this.readExact(16);
    if (header[0] !== 0x54 || header[1] !== 0xfd) {
      throw new Error("Unexpected TI-Nspire USB packet header; refusing protocol fallback.");
    }
    const extendedLength = header[12] === 255 ? await this.readExact(4) : new Uint8Array(0);
    const count = header[12] === 255
      ? new DataView(extendedLength.buffer, extendedLength.byteOffset, 4).getUint32(0, true)
      : header[12];
    if (count > 4 * 1024 * 1024) throw new Error("Unexpectedly large USB response.");
    const data = await this.readExact(count);
    return parsePacket(concat(header, extendedLength, data));
  }

  async initialize() {
    if (this.initialized) return;
    // Unlike the browser tool's legacy reconnect path, this implementation
    // does not issue a bus reset. If no address request is waiting, it stops.
    const request = await this.receiveRawPacket();
    if (request.srcSid !== 0x4003) throw new Error("No TI-Nspire address request was received.");
    await this.write(makePacket(Uint8Array.of(0x64, 0x01, 0xff, 0x00), {
      srcSid: this.hostSid,
      dstSid: this.deviceSid,
      seq: this.sequence
    }));
    this.hostSid = 0x8000;
    this.initialized = true;
  }

  ackFor(received, negative = false) {
    return makePacket(be16(received.dstSid), {
      srcSid: negative ? 0x00d3 : (received.seq ? 0x00ff : 0x00fe),
      dstSid: received.srcSid,
      ack: 0x0a,
      seq: received.seq
    });
  }

  async sendData(data, sourceSid = null) {
    await this.write(makePacket(data, {
      srcSid: sourceSid ?? this.hostSid,
      dstSid: this.deviceSid,
      seq: this.sequence
    }));
    for (let attempt = 0; attempt < 32; attempt++) {
      const response = await this.receiveRawPacket();
      if (response.dstSid === this.hostSid) {
        if (response.srcSid === 0xff || response.srcSid === 0xfe) {
          this.sequence = (this.sequence % 255) + 1;
          return;
        }
        if (response.srcSid === 0xd3) throw new Error("The calculator rejected a USB packet.");
        await this.write(this.ackFor(response));
        this.queue.push(response);
      } else {
        await this.write(this.ackFor(response, response.dstSid !== 0x40de));
      }
    }
    throw new Error("Too many unexpected TI-Nspire USB packets.");
  }

  async receiveData() {
    for (let attempt = 0; attempt < 32; attempt++) {
      const alreadyAcknowledged = this.queue.length > 0;
      const response = alreadyAcknowledged ? this.queue.shift() : await this.receiveRawPacket();
      if (response.dstSid !== this.hostSid) {
        await this.write(this.ackFor(response, response.dstSid !== 0x40de));
        continue;
      }
      if (!alreadyAcknowledged) await this.write(this.ackFor(response));
      return response.data;
    }
    throw new Error("The calculator did not return a file-service response.");
  }

  async disconnectService() {
    if (!this.activeService || this.broken) return;
    try {
      await this.sendData(be16(this.hostSid), 0x40de);
    } finally {
      this.activeService = false;
      this.hostSid++;
      this.queue = [];
    }
  }

  async usingFileService(callback) {
    if (!this.opened || !this.initialized || this.broken || this.busy) {
      throw new Error("No usable TI-Nspire file-service connection. Connect or reconnect first.");
    }
    this.busy = true;
    this.deviceSid = FILE_SERVICE;
    this.activeService = true;
    try {
      return await callback();
    } finally {
      try { await this.disconnectService(); }
      finally { this.busy = false; }
    }
  }

  async listDirectory(path) {
    path = pathName(path);
    return this.usingFileService(async () => {
      await this.sendData(concat(Uint8Array.of(0x0d), pathField(path)));
      const opening = await this.receiveData();
      if (opening[0] !== 0xff || opening[1] !== 0) throw new Error(`Could not open calculator folder ${path}.`);
      const entries = [];
      let closed = false;
      try {
        for (let index = 0; index < 8192; index++) {
          await this.sendData(Uint8Array.of(0x0e));
          const entry = await this.receiveData();
          if (entry[0] === 0xff && entry[1] === 0x11) break;
          const parsed = parseDirectoryEntry(entry);
          entries.push({ ...parsed, path: `${path.replace(/\/$/, "")}/${parsed.name}` });
        }
      } finally {
        await this.sendData(Uint8Array.of(0x0f));
        const done = await this.receiveData();
        closed = done[0] === 0xff && done[1] === 0;
      }
      if (!closed) throw new Error(`Calculator did not close folder enumeration for ${path}.`);
      return entries;
    });
  }

  async readFile(path) {
    path = pathName(path);
    if (!/^\/documents\/ndless\/screenshot_\d+\.ppm\.tns$/i.test(path)) {
      throw new Error("For safety, this bridge reads only /documents/ndless/screenshot_N.ppm.tns files.");
    }
    return this.usingFileService(async () => {
      await this.sendData(concat(Uint8Array.of(0x07, 0x01), pathField(path)));
      const info = await this.receiveData();
      if (info.length < 15 || info[0] !== 3 || info[1] !== 1) {
        throw new Error("The calculator could not open the selected screenshot file.");
      }
      const count = new DataView(info.buffer, info.byteOffset, info.byteLength).getUint32(11, false);
      if (count <= 0 || count > MAX_SCREENSHOT_BYTES) {
        throw new Error(`Screenshot file size is outside the allowed limit (${count} bytes).`);
      }
      await this.sendData(Uint8Array.of(4));
      const contents = new Uint8Array(count);
      let offset = 0;
      while (offset < count) {
        const chunk = await this.receiveData();
        if (chunk[0] !== 5 || chunk.length < 2) throw new Error("Invalid screenshot data block.");
        const amount = Math.min(chunk.length - 1, count - offset);
        contents.set(chunk.subarray(1, 1 + amount), offset);
        offset += amount;
      }
      await this.sendData(Uint8Array.of(0xff, 0x00));
      return contents;
    });
  }
}

export const TI_USB_IDS = Object.freeze({ vendor: TI_VENDOR_ID, classicCx: PRODUCT_CLASSIC_CX, cxII: PRODUCT_CX_II });
