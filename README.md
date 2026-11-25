# DevonCraft USB Bridge

A local MCP server that retrieves an image saved by DevonCraft on a TI-Nspire calculator, including while the game is still running.

## What it does

1. Finds supported TI-Nspire USB devices (`0451:e012` for the classic CX family; `0451:e022` is detected but not enabled in this first build).
2. Connects using the TI-Nspire file-transfer service (`0x4060`).
3. Lists only files matching `screenshot_N.ppm.tns` in `/documents/ndless`.
4. Downloads the newest matching file, decodes its PPM pixels, and returns a PNG image through MCP.

## Running-game capture workflow

1. Launch the updated DevonCraft build and enter the village/world.
2. Aim the camera at the scene you want to capture.
3. Press **Ctrl + Shift + Period**. DevonCraft saves the current rendered frame to `/documents/ndless/screenshot_N.ppm.tns` and temporarily enables the TI-Nspire OS interrupt handling needed for its normal USB file-transfer service.
4. **Keep DevonCraft running.** Use this bridge to call `list_calculators`, `connect_calculator`, and `retrieve_latest_screenshot`.
5. When the transfer is finished, press **Ctrl + Shift + Period** again to close the USB transfer window, or exit DevonCraft normally; the game restores the prior interrupt state during shutdown.

The original **Ctrl + Period** shortcut remains a local screenshot save and does not open the USB transfer window. Do not use TNS Tool's **Screen capture** button; the bridge reads the saved screenshot file and does not invoke the live screen-capture service.

## Safety boundary

This plugin never sends the screen RLE service request (`0x4024`), never writes/deletes/renames calculator files, and does not call the USB device reset function. It uses only the normal file service (`0x4060`) to read DevonCraft's own saved PPM file. The running-game transfer mode temporarily re-enables the OS IRQ path; it is opt-in and is restored when toggled off or when DevonCraft exits.

The transport and the new game-side IRQ window have not yet been validated on the user's physical calculator. Software tests and CI builds do not prove that a real calculator's USB service will complete while DevonCraft remains open. If the connection fails, do not use live Screen capture as a fallback; close the transfer window and exit the game normally.

## Host requirements

This is a **local** stdio MCP server. Saving the plugin to an account does not grant a cloud ChatGPT session access to your computer's USB port. The server must run in a compatible local MCP host on the same computer that can access the calculator.

Required:

- Node.js 20 or newer and npm.
- A local MCP host that supports `stdio` servers.
- TI-Nspire calculator connected using a USB data cable.
- TI-Nspire USB interface not already claimed by TI software or another browser tab.
- `libusb` on Linux; `usb` uses libusb on this version of the package.

### Chromebook / ChromeOS Linux environment

1. Enable the Linux development environment.
2. In ChromeOS USB preferences, share the connected TI-Nspire device with Linux.
3. In the Linux terminal, install the USB build/runtime dependencies:

   ```sh
   sudo apt update
   sudo apt install -y libusb-1.0-0 libusb-1.0-0-dev build-essential pkg-config
   ```

4. Install this plugin's runtime dependencies in its installed folder:

   ```sh
   npm install --omit=dev
   ```

5. Configure your local MCP host to launch `node server/index.mjs` with the plugin folder as its working directory.

The ChatGPT web app in ChromeOS does not itself launch this local stdio process. If your current host cannot run local MCP servers, this package can still be installed in a compatible local MCP host, but its tools will not appear in the web chat until that host exposes them.

## Tools

- `list_calculators` — enumerate supported TI-Nspire USB devices without opening them.
- `connect_calculator` — open a selected classic CX device and verify file-service access.
- `list_devoncraft_screenshots` — list only DevonCraft's numbered PPM screenshot files.
- `retrieve_latest_screenshot` — receive the newest numbered screenshot and return it as PNG.
- `disconnect_calculator` — close the local USB session.

No tool sends the `0x4024` live-screen command.
