import { readFile } from "node:fs/promises";
import * as ImGui from "./imgui";
import * as ImGui_Impl from "./imgui_impl_adamas";
import { robotoTTF } from "./roboto";

const DEFAULT_FONT_SIZE_PX = 32;

export type ImGuiStyleColor = "dark" | "light" | "classic";

export interface ImGuiWindowInitOptions extends ImGui_Impl.AdamasInitOptions {
	styleColor?: ImGuiStyleColor;
	noBackground?: boolean;
	fontPath?: string;
	fontSizePx?: number;
}

async function loadFont(fontPath: string | undefined): Promise<Uint8Array> {
	if (fontPath !== undefined) {
		return Uint8Array.from(await readFile(fontPath));
	}
	return Uint8Array.from(Buffer.from(robotoTTF, "base64"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

export async function CreateImGuiWindow(
	initOptions: ImGuiWindowInitOptions,
	ui: (imgui: typeof ImGui, timestep: number) => void,
) {
	await ImGui.default();
	ImGui.CHECKVERSION();
	ImGui.CreateContext();

	const {
		styleColor = "light",
		noBackground = false,
		fontPath,
		fontSizePx = DEFAULT_FONT_SIZE_PX,
		...adamasInitOptions
	} = initOptions;
	const runtimeOptions: ImGui_Impl.AdamasInitOptions = adamasInitOptions;

	const io = ImGui.GetIO();
	const font = await loadFont(fontPath);
	io.FontDefault = io.Fonts.AddFontFromMemoryTTF(
		toArrayBuffer(font),
		fontSizePx,
		null,
		io.Fonts.GetGlyphRangesDefault(),
	);
	switch (styleColor) {
		case "dark":
			ImGui.StyleColorsDark();
			break;
		case "light":
			ImGui.StyleColorsLight();
			break;
		case "classic":
			ImGui.StyleColorsClassic();
			break;
	}

	ImGui_Impl.Init(runtimeOptions);

	let lastFrameTime = Date.now();
	return setInterval(() => {
		const now = Date.now();
		const timestep = now - lastFrameTime;
		lastFrameTime = now;

		ImGui_Impl.NewFrame(timestep);
		ImGui.NewFrame();

		ImGui.SetNextWindowPos(
			new ImGui.Vec2(0, 0),
			ImGui.Cond.Always,
			new ImGui.Vec2(0, 0),
		);
		ImGui.SetNextWindowSize(
			new ImGui.Vec2(runtimeOptions.displayWidth, runtimeOptions.displayHeight),
			ImGui.Cond.Always,
		);

		let windowFlags =
			ImGui.WindowFlags.NoTitleBar |
			ImGui.WindowFlags.NoResize |
			ImGui.WindowFlags.NoMove |
			ImGui.WindowFlags.NoCollapse |
			ImGui.WindowFlags.NoNav |
			ImGui.WindowFlags.NoSavedSettings |
			ImGui.WindowFlags.NoBringToFrontOnFocus;
		if (noBackground) {
			windowFlags |= ImGui.WindowFlags.NoBackground;
		}

		ImGui.Begin("UI", null, windowFlags);
		ui(ImGui, timestep);
		ImGui.End();

		ImGui_Impl.RenderDrawData();
	}, 1000 / 30);
}
