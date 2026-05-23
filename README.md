# imgui-adamas

`imgui-adamas` brings [Dear ImGui](https://github.com/ocornut/imgui) to the [Adamas VR](https://www.adamasvr.com/) platform through a custom Adamas backend and a TypeScript-friendly JavaScript distribution.

This project builds on the JavaScript cross-compilation and TypeScript interface provided by [imgui-js](https://github.com/flyover/imgui-js), then extends it with an Adamas-specific rendering backend in [imgui_impl_adamas.ts](imgui_impl_adamas.ts). It also includes a convenience helper in [imgui_window.ts](imgui_window.ts) for quickly creating an ImGui-backed panel in an Adamas project.

For Adamas platform documentation, see [Adamas Docs](https://docs.adamasvr.com/).

## Overview

This library enables Adamas projects to render Dear ImGui user interfaces in VR. It is intended for VR developers who want a practical immediate-mode UI workflow for debugging tools, in-world control panels, development overlays, and custom runtime interfaces.

The project provides:

- A Dear ImGui JavaScript build with TypeScript bindings.
- A custom backend for rendering Dear ImGui on the Adamas VR platform.
- A helper API for creating and updating an ImGui window with minimal setup.

## Credits

This project is derived from and depends on prior work from the following projects:

- [ocornut/imgui](https://github.com/ocornut/imgui) for the original Dear ImGui implementation.
- [flyover/imgui-js](https://github.com/flyover/imgui-js) for the JavaScript cross-compilation and TypeScript interface used by this project.

## Installation

Install the package from npm:

```bash
npm install @adamasvr/imgui
```

## Quick Start

Import the helper:

```ts
import { CreateImGuiWindow } from "@adamasvr/imgui";
```

Create the window during your Adamas project setup flow. The example below focuses only on how Dear ImGui is integrated with Adamas VR:

```ts
import { Project } from "@adamasvr/sdk";
import { projectBundle } from "adamasvr:editor";
import { CreateImGuiWindow } from "@adamasvr/imgui";

Project.FromBundle(projectBundle).Launch(async (sceneGraph, project) => {
	const color = [0.2, 0.45, 1.0, 1.0];

	await CreateImGuiWindow(
		project,
		{
			targetEntity: sceneGraph["@UI Panel"].entityId,
			displayWidth: 600,
			displayHeight: 400,
		},
		(imgui) => {
			imgui.Text(`Framerate: ${imgui.GetIO().Framerate.toFixed(1)} FPS`);
			imgui.Separator();
			imgui.Text("Example UI");
			imgui.Separator();
			imgui.ColorEdit4("Color", color);
		},
	);
});
```

## Usage Notes

`CreateImGuiWindow` is a convenience helper intended to simplify common setup and rendering patterns.

For fully custom Dear ImGui integration on Adamas, you can use the exports from [imgui_impl_adamas.ts](imgui_impl_adamas.ts) directly and treat [imgui_window.ts](imgui_window.ts) as a reference implementation. This approach is recommended when you need custom lifecycle control, rendering behavior, or a deeper integration with your project architecture.

## Included Components

- [imgui_impl_adamas.ts](imgui_impl_adamas.ts): Adamas-specific Dear ImGui backend.
- [imgui_window.ts](imgui_window.ts): Helper for creating and rendering an ImGui window quickly.
