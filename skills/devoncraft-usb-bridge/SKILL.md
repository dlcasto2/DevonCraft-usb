---
name: devoncraft-usb-bridge
description: Use when the user needs to retrieve a DevonCraft screenshot from a TI-Nspire over local USB, including while the game is running.
---

# DevonCraft USB screenshot retrieval

Use the local `devoncraft-usb` MCP server only when its tools are present. The server must run on the computer connected to the TI-Nspire. If the tools are not available, explain that the account plugin cannot access a local USB device from a cloud-only ChatGPT session; do not pretend it is connected.

## Required safety rules

- Never send TI-Nspire screen RLE service `0x4024`. The user's previous attempt to use TNS Tool's live Screen capture caused the calculator to reboot.
- Never reset the USB device, write files, delete files, rename files, or modify calculator storage.
- Use file service `0x4060` only, and only read DevonCraft's existing screenshot files under `/documents/ndless`.
- Do not try to capture the physical display through the host USB capture endpoint. DevonCraft creates the screenshot from its own framebuffer.
- The in-game USB transfer window is opt-in. Do not tell the user to use it on an old build that does not contain Ctrl + Shift + Period.
- Do not claim physical hardware compatibility until the user's own calculator has completed a successful retrieval.

## Workflow while DevonCraft is running

1. Ensure the calculator is running the updated DevonCraft build.
2. Ask the user to aim at the scene and press **Ctrl + Shift + Period**. This saves a PPM frame and temporarily re-enables OS IRQ handling for the normal USB file-transfer service.
3. Keep the game open. Call `list_calculators`; if no device appears, explain USB passthrough / driver access needs attention and do not reset or use another protocol.
4. Call `connect_calculator` using the selected device index. This release supports classic TI-Nspire CX product ID `0451:e012`. If an unsupported product ID is detected, explain the limitation without attempting a reset or fallback.
5. Call `list_devoncraft_screenshots` to confirm the new numbered file.
6. Call `retrieve_latest_screenshot` to receive the latest PNG image. Check the returned image; do not infer contents from the filename.
7. Call `disconnect_calculator` after retrieval.
8. Ask the user to press **Ctrl + Shift + Period** again to close the temporary transfer window, or to exit DevonCraft normally. The game also restores the prior IRQ state during normal shutdown.

## Workflow after DevonCraft has exited

1. Press **Ctrl + Period** in DevonCraft and wait for the `Screenshot taken (N)!` message.
2. Exit DevonCraft normally with Esc.
3. Call `list_calculators`, `connect_calculator`, `list_devoncraft_screenshots`, and `retrieve_latest_screenshot` as above.

## Failure handling

- A connection or protocol error is a failure, not proof that the calculator has no screenshot.
- Never send `0x4024` as a fallback.
- If the folder cannot be read, stop. Do not scan arbitrary device folders or attempt write commands.
- If the file is not a supported PPM image, report the format issue and keep the original file untouched.
- If the game-running transfer window fails on hardware, ask the user to close it with Ctrl + Shift + Period if possible, then exit DevonCraft normally and retry the already-saved screenshot from the OS desktop.
- If a tool call reports the server is unavailable, the user needs to install/enable the local stdio server in a compatible host. The private account plugin alone does not grant USB access to ChatGPT web/mobile.
