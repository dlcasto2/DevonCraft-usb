import { WebUSB } from "usb";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listTiDevices, NspireFileReader } from "./nspire.mjs";
import { parsePpm, encodePng } from "./ppm.mjs";

const SCREENSHOT_DIRECTORY = "/documents/ndless";
const SCREENSHOT_PATTERN = /^screenshot_(\d+)\.ppm\.tns$/i;

const usb = new WebUSB({ allowAllDevices: true });
const server = new McpServer({
  name: "devoncraft-usb-bridge",
  version: "0.1.0"
});

let reader = null;
let connectedDeviceLabel = null;

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }]
  };
}

function requireConnection() {
  if (!reader?.connected) throw new Error("No TI-Nspire is connected. Call list_calculators, then connect_calculator.");
  return reader;
}

async function listScreenshotEntries(activeReader) {
  const entries = await activeReader.listDirectory(SCREENSHOT_DIRECTORY);
  return entries
    .filter(entry => !entry.isDir && SCREENSHOT_PATTERN.test(entry.name))
    .map(entry => {
      const match = entry.name.match(SCREENSHOT_PATTERN);
      return { ...entry, screenshotNumber: Number(match[1]) };
    })
    .sort((a, b) => a.screenshotNumber - b.screenshotNumber);
}

server.tool(
  "list_calculators",
  "List connected TI-Nspire USB devices visible to this local MCP process. Does not reset or communicate with them.",
  {},
  async () => {
    try {
      const devices = await listTiDevices(usb);
      if (devices.length === 0) {
        return textResult("No supported TI-Nspire USB devices are visible. On ChromeOS, share the calculator with Linux first; close TNS Tool and TI software before connecting through this bridge.");
      }
      return textResult(JSON.stringify(devices, null, 2));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "connect_calculator",
  "Open a selected classic TI-Nspire CX USB device and verify read-only file-service access. If DevonCraft is running, first use Ctrl + Shift + Period in-game to enable its temporary USB transfer window. Does not issue a USB reset or live-screen request.",
  { device_index: z.number().int().min(0).default(0) },
  async ({ device_index }) => {
    try {
      if (reader?.connected) throw new Error("A calculator is already connected. Disconnect it before selecting another device.");
      const devices = (await usb.getDevices()).filter(device =>
        device.vendorId === 0x0451 && [0xe012, 0xe022].includes(device.productId));
      const device = devices[device_index];
      if (!device) throw new Error(`No TI-Nspire device exists at index ${device_index}. Call list_calculators again.`);
      if (device.productId !== 0xe012) {
        throw new Error("This first release supports classic TI-Nspire CX (USB ID 0451:e012). CX II (0451:e022) is detected but not yet supported; no reset or protocol fallback was attempted.");
      }
      const candidate = new NspireFileReader(device);
      const rootEntries = await candidate.connect();
      reader = candidate;
      connectedDeviceLabel = device.productName || "TI-Nspire CX";
      return textResult(`Connected to ${connectedDeviceLabel} using read-only file service 0x4060. The calculator root contains ${rootEntries.length} entries. Live-screen service 0x4024 was not used.`);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "list_devoncraft_screenshots",
  "List numbered DevonCraft PPM screenshots in /documents/ndless. Works while DevonCraft remains open after Ctrl + Shift + Period enables its USB transfer window.",
  {},
  async () => {
    try {
      const activeReader = requireConnection();
      const entries = await listScreenshotEntries(activeReader);
      if (entries.length === 0) return textResult(`No DevonCraft screenshot files were found in ${SCREENSHOT_DIRECTORY}. While in the game, aim at the scene and press Ctrl + Shift + Period. Keep DevonCraft running; this saves the frame and opens the temporary USB transfer window. Do not use TNS Tool Screen capture.`);
      const display = entries.map(entry => ({
        screenshot: entry.screenshotNumber,
        name: entry.name,
        path: entry.path,
        bytes: entry.size
      }));
      return textResult(JSON.stringify(display, null, 2));
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "retrieve_latest_screenshot",
  "Download the highest-numbered DevonCraft PPM screenshot over file service 0x4060 and return it as PNG, including while DevonCraft is still running after Ctrl + Shift + Period. Never uses live-screen service 0x4024.",
  {},
  async () => {
    try {
      const activeReader = requireConnection();
      const entries = await listScreenshotEntries(activeReader);
      if (entries.length === 0) throw new Error(`No saved DevonCraft screenshot exists in ${SCREENSHOT_DIRECTORY}. While DevonCraft is running, press Ctrl + Shift + Period to save a frame and open the temporary USB transfer window, then retry. Do not use TNS Tool Screen capture.`);
      const latest = entries[entries.length - 1];
      const bytes = await activeReader.readFile(latest.path);
      const ppm = parsePpm(Buffer.from(bytes));
      const png = encodePng(ppm);
      return {
        content: [
          { type: "text", text: `Retrieved DevonCraft screenshot ${latest.screenshotNumber} (${latest.name}) over USB while the game may remain running. Converted ${ppm.width} × ${ppm.height} PPM pixels to PNG. Only file service 0x4060 was used; no live-screen capture command was sent.` },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" }
        ]
      };
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "disconnect_calculator",
  "Close the TI-Nspire USB session. No calculator files are changed.",
  {},
  async () => {
    try {
      if (!reader) return textResult("No calculator session is open.");
      const active = reader;
      reader = null;
      const label = connectedDeviceLabel || "TI-Nspire";
      connectedDeviceLabel = null;
      await active.close();
      return textResult(`Disconnected from ${label}. Calculator files were not modified.`);
    } catch (error) {
      return errorResult(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  try { await reader?.close(); } catch { /* best-effort local cleanup */ }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
