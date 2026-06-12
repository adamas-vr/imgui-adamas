import * as ImGui from "./imgui";
import {
	AlphaMode,
	Device,
	DevicePath,
	type DeviceSubscription,
	type Entity,
	type Material,
	MaterialManager,
	MaterialProperty,
	NewQuadMesh,
	TextureFilterMode,
	TextureManager,
	TextureWrapMode,
	SharedTexture,
	TransformManager,
	User,
	RenderableManager,
	ShadowCastingMode,
} from "@adamasvr/sdk";
import { quat, vec2, vec3 } from "gl-matrix";

type TextureId = number;
type Hand = "left" | "right";
type HandPose = {
	origin: vec3;
	rotation: quat;
};

interface CpuTexture {
	width: number;
	height: number;
	rgba: Uint8Array;
}

interface RuntimeBase {
	options: Required<AdamasInitOptions>;
	shutdown: boolean;
	prevTime: number;
	framebuffer: Uint8Array;
	uploadBuffer: Uint8Array;
	textureRegistry: Map<TextureId, CpuTexture>;
	nextTextureId: number;
	input: {
		leftTrigger: number;
		rightTrigger: number;
		leftGrip: number;
		rightGrip: number;
		leftPrimaryAxis: vec2;
		rightPrimaryAxis: vec2;
	};
	preferredHand: Hand | null;
	cursorPosition: { x: number; y: number } | null;
	subscriptions: DeviceSubscription[];
}

interface RuntimeState extends RuntimeBase {
	outputTexture: SharedTexture;
	fontTextureId: TextureId;
	leftHandEntity: Entity;
	rightHandEntity: Entity;
	targetEntity: Entity;
	targetMaterial: Material;
}

export interface AdamasInitOptions {
	targetEntity: Entity;
	displayWidth: number;
	displayHeight: number;
	scrollSpeed?: number;
	scrollDeadzone?: number;
	clearColor?: [number, number, number, number];
	cursorColor?: [number, number, number, number];
}

const DEFAULT_OPTIONS: Required<
	Omit<AdamasInitOptions, "targetEntity" | "displayWidth" | "displayHeight">
> = {
	scrollSpeed: 0.25,
	scrollDeadzone: 0.2,
	clearColor: [0, 0, 0, 0],
	cursorColor: [20, 71, 230, 200],
};

function createRuntimeBase(options: AdamasInitOptions): RuntimeBase {
	const runtimeOptions = {
		...DEFAULT_OPTIONS,
		...options,
	};
	const framebufferSize =
		runtimeOptions.displayWidth * runtimeOptions.displayHeight * 4;
	return {
		options: runtimeOptions,
		shutdown: false,
		prevTime: 0,
		framebuffer: new Uint8Array(framebufferSize),
		uploadBuffer: new Uint8Array(framebufferSize),
		textureRegistry: new Map<TextureId, CpuTexture>(),
		nextTextureId: 1,
		input: {
			leftTrigger: 0,
			rightTrigger: 0,
			leftGrip: 0,
			rightGrip: 0,
			leftPrimaryAxis: vec2.fromValues(0, 0),
			rightPrimaryAxis: vec2.fromValues(0, 0),
		},
		preferredHand: null as Hand | null,
		cursorPosition: null as { x: number; y: number } | null,
		subscriptions: [] as DeviceSubscription[],
	};
}

let runtime!: RuntimeState;
let runtimeReady = false;
let initPromise: Promise<void> | null = null;

export let gl: null = null;
export let ctx: null = null;

let clipboardText = "";

function nextTextureId(state: RuntimeBase): TextureId {
	const id = state.nextTextureId++;
	return id;
}

function clearFramebuffer(): void {
	const [r, g, b, a] = runtime.options.clearColor;
	const rr = Math.round(Math.max(0, Math.min(1, r)) * 255);
	const gg = Math.round(Math.max(0, Math.min(1, g)) * 255);
	const bb = Math.round(Math.max(0, Math.min(1, b)) * 255);
	const aa = Math.round(Math.max(0, Math.min(1, a)) * 255);
	for (let i = 0; i < runtime.framebuffer.length; i += 4) {
		runtime.framebuffer[i + 0] = rr;
		runtime.framebuffer[i + 1] = gg;
		runtime.framebuffer[i + 2] = bb;
		runtime.framebuffer[i + 3] = aa;
	}
}

function framebufferIndex(x: number, y: number): number {
	return (y * runtime.options.displayWidth + x) * 4;
}

function drawCursorDot(): void {
	if (runtime.cursorPosition === null) {
		return;
	}
	const [r, g, b, a] = runtime.options.cursorColor;
	ImGui.GetForegroundDrawList().AddCircleFilled(
		new ImGui.ImVec2(runtime.cursorPosition.x, runtime.cursorPosition.y),
		4,
		ImGui.IM_COL32(r, g, b, a),
		32,
	);
}

function alphaBlendPixel(
	index: number,
	srcR: number,
	srcG: number,
	srcB: number,
	srcA: number,
): void {
	const dstR = runtime.framebuffer[index + 0] / 255;
	const dstG = runtime.framebuffer[index + 1] / 255;
	const dstB = runtime.framebuffer[index + 2] / 255;
	const dstA = runtime.framebuffer[index + 3] / 255;

	const outA = srcA + dstA * (1 - srcA);
	if (outA <= 0) {
		runtime.framebuffer[index + 0] = 0;
		runtime.framebuffer[index + 1] = 0;
		runtime.framebuffer[index + 2] = 0;
		runtime.framebuffer[index + 3] = 0;
		return;
	}

	const outR = (srcR * srcA + dstR * dstA * (1 - srcA)) / outA;
	const outG = (srcG * srcA + dstG * dstA * (1 - srcA)) / outA;
	const outB = (srcB * srcA + dstB * dstA * (1 - srcA)) / outA;

	runtime.framebuffer[index + 0] = Math.round(
		Math.max(0, Math.min(1, outR)) * 255,
	);
	runtime.framebuffer[index + 1] = Math.round(
		Math.max(0, Math.min(1, outG)) * 255,
	);
	runtime.framebuffer[index + 2] = Math.round(
		Math.max(0, Math.min(1, outB)) * 255,
	);
	runtime.framebuffer[index + 3] =
		srcA > 0 ? 255 : Math.round(Math.max(0, Math.min(1, outA)) * 255);
}

function sampleTexture(
	texture: CpuTexture,
	u: number,
	v: number,
): [number, number, number, number] {
	const uu = Math.max(0, Math.min(1, u));
	const vv = Math.max(0, Math.min(1, v));
	const x = Math.max(
		0,
		Math.min(texture.width - 1, Math.floor(uu * (texture.width - 1) + 0.5)),
	);
	const y = Math.max(
		0,
		Math.min(texture.height - 1, Math.floor(vv * (texture.height - 1) + 0.5)),
	);
	const idx = (y * texture.width + x) * 4;
	return [
		texture.rgba[idx + 0] / 255,
		texture.rgba[idx + 1] / 255,
		texture.rgba[idx + 2] / 255,
		texture.rgba[idx + 3] / 255,
	];
}

function edge(
	ax: number,
	ay: number,
	bx: number,
	by: number,
	px: number,
	py: number,
): number {
	return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function rasterizeTriangle(
	v0: ImGui.DrawVert,
	v1: ImGui.DrawVert,
	v2: ImGui.DrawVert,
	texture: CpuTexture | null,
	clipMinX: number,
	clipMinY: number,
	clipMaxX: number,
	clipMaxY: number,
	displayPosX: number,
	displayPosY: number,
): void {
	const x0 = v0.pos[0] - displayPosX;
	const y0 = v0.pos[1] - displayPosY;
	const x1 = v1.pos[0] - displayPosX;
	const y1 = v1.pos[1] - displayPosY;
	const x2 = v2.pos[0] - displayPosX;
	const y2 = v2.pos[1] - displayPosY;

	const area = edge(x0, y0, x1, y1, x2, y2);
	if (area === 0) {
		return;
	}

	const minX = Math.max(
		0,
		Math.floor(Math.min(x0, x1, x2)),
		Math.floor(clipMinX),
	);
	const minY = Math.max(
		0,
		Math.floor(Math.min(y0, y1, y2)),
		Math.floor(clipMinY),
	);
	const maxX = Math.min(
		runtime.options.displayWidth - 1,
		Math.ceil(Math.max(x0, x1, x2)),
		Math.ceil(clipMaxX) - 1,
	);
	const maxY = Math.min(
		runtime.options.displayHeight - 1,
		Math.ceil(Math.max(y0, y1, y2)),
		Math.ceil(clipMaxY) - 1,
	);

	if (minX > maxX || minY > maxY) {
		return;
	}

	for (let py = minY; py <= maxY; py++) {
		for (let px = minX; px <= maxX; px++) {
			const sampleX = px + 0.5;
			const sampleY = py + 0.5;
			const w0 = edge(x1, y1, x2, y2, sampleX, sampleY);
			const w1 = edge(x2, y2, x0, y0, sampleX, sampleY);
			const w2 = edge(x0, y0, x1, y1, sampleX, sampleY);

			const inside =
				(area > 0 && w0 >= 0 && w1 >= 0 && w2 >= 0) ||
				(area < 0 && w0 <= 0 && w1 <= 0 && w2 <= 0);
			if (!inside) {
				continue;
			}

			const invArea = 1 / area;
			const a0 = w0 * invArea;
			const a1 = w1 * invArea;
			const a2 = w2 * invArea;

			const uvx = v0.uv[0] * a0 + v1.uv[0] * a1 + v2.uv[0] * a2;
			const uvy = v0.uv[1] * a0 + v1.uv[1] * a1 + v2.uv[1] * a2;

			const c0 = v0.col[0];
			const c1 = v1.col[0];
			const c2 = v2.col[0];
			const vr =
				(((c0 >> 0) & 0xff) * a0 +
					((c1 >> 0) & 0xff) * a1 +
					((c2 >> 0) & 0xff) * a2) /
				255;
			const vg =
				(((c0 >> 8) & 0xff) * a0 +
					((c1 >> 8) & 0xff) * a1 +
					((c2 >> 8) & 0xff) * a2) /
				255;
			const vb =
				(((c0 >> 16) & 0xff) * a0 +
					((c1 >> 16) & 0xff) * a1 +
					((c2 >> 16) & 0xff) * a2) /
				255;
			const va =
				(((c0 >> 24) & 0xff) * a0 +
					((c1 >> 24) & 0xff) * a1 +
					((c2 >> 24) & 0xff) * a2) /
				255;

			let tr = 1;
			let tg = 1;
			let tb = 1;
			let ta = 1;
			if (texture !== null) {
				[tr, tg, tb, ta] = sampleTexture(texture, uvx, uvy);
			}

			const outR = vr * tr;
			const outG = vg * tg;
			const outB = vb * tb;
			const outA = va * ta;

			alphaBlendPixel(framebufferIndex(px, py), outR, outG, outB, outA);
		}
	}
}

function getTexture(textureId: TextureId): CpuTexture | null {
	return runtime.textureRegistry.get(textureId) ?? null;
}

function computeDeltaTime(time: number): number {
	if (runtime.prevTime === 0) {
		runtime.prevTime = time;
		return 1 / 60;
	}
	if (time >= 0 && time <= 1) {
		return time;
	}
	if (time > runtime.prevTime) {
		const delta = (time - runtime.prevTime) / 1000;
		runtime.prevTime = time;
		return delta > 0 ? delta : 1 / 60;
	}
	runtime.prevTime = time;
	return 1 / 60;
}

function currentButtonValue(hand: Hand, kind: "trigger" | "grip"): number {
	if (hand === "left") {
		if (kind === "trigger") return runtime.input.leftTrigger;
		return runtime.input.leftGrip;
	}
	if (kind === "trigger") return runtime.input.rightTrigger;
	return runtime.input.rightGrip;
}

async function subscribeDeviceValue<T extends number | vec2>(
	state: RuntimeBase,
	devicePath: string,
	setter: (value: T) => void,
): Promise<void> {
	setter((await Device.GetValue(devicePath)) as T);
	const subscription = await Device.SubscribeValueChange(devicePath, (value) =>
		setter(value as T),
	);
	state.subscriptions.push(subscription);
}

async function initializePanelEntity(targetEntity: Entity): Promise<Material> {
	if (!(await RenderableManager.HasComponent(targetEntity))) {
		await RenderableManager.Create(targetEntity);
		await RenderableManager.SetReceiveShadows(targetEntity, false);
		await RenderableManager.SetShadowMode(targetEntity, ShadowCastingMode.Off);
	}

	try {
		await RenderableManager.GetMesh(targetEntity);
	} catch {
		await RenderableManager.SetMesh(targetEntity, await NewQuadMesh());
	}

	try {
		return await RenderableManager.GetMaterial(targetEntity);
	} catch {
		const targetMaterial = await MaterialManager.Create();

		await RenderableManager.SetMaterial(targetEntity, targetMaterial);

		await MaterialManager.SetAlphaMode(targetMaterial, AlphaMode.Blend);
		await MaterialManager.SetFloat(targetMaterial, MaterialProperty.Culling, 0);
		return targetMaterial;
	}
}

async function createOutputTexture(
	state: RuntimeBase,
	targetMaterial: Material,
): Promise<SharedTexture> {
	const outputTexture = await SharedTexture.Create(
		state.options.displayWidth,
		state.options.displayHeight,
		true,
	);
	await TextureManager.SetFilterMode(
		outputTexture.textureHandle,
		TextureFilterMode.Linear,
	);
	await TextureManager.SetWrapModeU(
		outputTexture.textureHandle,
		TextureWrapMode.ClampToEdge,
	);
	await TextureManager.SetWrapModeV(
		outputTexture.textureHandle,
		TextureWrapMode.ClampToEdge,
	);
	await MaterialManager.SetTexture(
		targetMaterial,
		MaterialProperty.BaseColorMap,
		outputTexture.textureHandle,
	);
	await MaterialManager.SetTexture(
		targetMaterial,
		MaterialProperty.EmissionMap,
		outputTexture.textureHandle,
	);
	return outputTexture;
}

function createFontTexture(state: RuntimeBase): TextureId {
	const { width, height, pixels } = ImGui.GetIO().Fonts.GetTexDataAsRGBA32();
	const id = nextTextureId(state);
	const rgba = new Uint8Array(
		pixels.buffer,
		pixels.byteOffset,
		pixels.byteLength,
	);
	const cpuTexture: CpuTexture = {
		width,
		height,
		rgba: new Uint8Array(rgba),
	};
	state.textureRegistry.set(id, cpuTexture);
	ImGui.GetIO().Fonts.TexID = id;
	return id;
}

async function createRuntime(
	options: AdamasInitOptions,
): Promise<RuntimeState> {
	const state = createRuntimeBase(options);
	const localUser = await User.GetLocalUser();
	const [leftHandEntity, rightHandEntity, targetMaterial] = await Promise.all([
		localUser.GetLeftHandEntity(),
		localUser.GetRightHandEntity(),
		initializePanelEntity(options.targetEntity),
	]);

	await Promise.all([
		subscribeDeviceValue<number>(state, DevicePath.LEFT_TRIGGER, (value) => {
			state.input.leftTrigger = value;
		}),
		subscribeDeviceValue<number>(state, DevicePath.RIGHT_TRIGGER, (value) => {
			state.input.rightTrigger = value;
		}),
		subscribeDeviceValue<number>(state, DevicePath.LEFT_GRIP, (value) => {
			state.input.leftGrip = value;
		}),
		subscribeDeviceValue<number>(state, DevicePath.RIGHT_GRIP, (value) => {
			state.input.rightGrip = value;
		}),
		subscribeDeviceValue<vec2>(
			state,
			DevicePath.LEFT_PRIMARY_2D_AXIS,
			(value) => vec2.copy(state.input.leftPrimaryAxis, value),
		),
		subscribeDeviceValue<vec2>(
			state,
			DevicePath.RIGHT_PRIMARY_2D_AXIS,
			(value) => vec2.copy(state.input.rightPrimaryAxis, value),
		),
	]);

	const [outputTexture, fontTextureId] = await Promise.all([
		createOutputTexture(state, targetMaterial),
		Promise.resolve(createFontTexture(state)),
	]);

	return {
		...state,
		outputTexture,
		fontTextureId,
		leftHandEntity,
		rightHandEntity,
		targetEntity: options.targetEntity,
		targetMaterial,
	};
}

function intersectHand(
	handPose: HandPose | null,
	panelPosition: vec3,
	panelRotation: quat,
	panelScale: vec3,
): { x: number; y: number } | null {
	if (handPose === null) {
		return null;
	}

	const { origin, rotation } = handPose;
	const direction = vec3.normalize(
		vec3.create(),
		vec3.transformQuat(vec3.create(), vec3.fromValues(0, 0, -1), rotation),
	);
	//FIXME: todo controller ray direction is assumed to be local -Z because the SDK typings do not document a canonical pointer pose axis.
	const planeNormal = vec3.transformQuat(
		vec3.create(),
		vec3.fromValues(0, 0, 1),
		panelRotation,
	);
	const denominator = vec3.dot(direction, planeNormal);
	if (Math.abs(denominator) < 1e-5) {
		return null;
	}

	const originToPlane = vec3.sub(vec3.create(), panelPosition, origin);
	const distance = vec3.dot(originToPlane, planeNormal) / denominator;
	if (distance <= 0) {
		return null;
	}

	const hit = vec3.scaleAndAdd(vec3.create(), origin, direction, distance);
	const panelLocal = vec3.sub(vec3.create(), hit, panelPosition);
	const inverseRotation = quat.invert(quat.create(), panelRotation);
	vec3.transformQuat(panelLocal, panelLocal, inverseRotation);

	const x =
		(panelLocal[0] / panelScale[0] + 0.5) * runtime.options.displayWidth;
	const y =
		(0.5 - panelLocal[1] / panelScale[1]) * runtime.options.displayHeight;
	const inside =
		x >= 0 &&
		x <= runtime.options.displayWidth &&
		y >= 0 &&
		y <= runtime.options.displayHeight;

	return inside ? { x, y } : null;
}

async function updateMouseFromHands(): Promise<void> {
	const io = ImGui.GetIO();
	const targetEntity = runtime.targetEntity;
	const leftHandEntity = runtime.leftHandEntity;
	const rightHandEntity = runtime.rightHandEntity;
	const [
		panelPosition,
		panelRotation,
		panelScale,
		leftHandPose,
		rightHandPose,
	] = await Promise.all([
		TransformManager.GetWorldPosition(targetEntity),
		TransformManager.GetWorldRotation(targetEntity),
		TransformManager.GetLocalScale(targetEntity),
		Promise.all([
			TransformManager.GetWorldPosition(leftHandEntity),
			TransformManager.GetWorldRotation(leftHandEntity),
		]).then(([origin, rotation]) => ({ origin, rotation })),
		Promise.all([
			TransformManager.GetWorldPosition(rightHandEntity),
			TransformManager.GetWorldRotation(rightHandEntity),
		]).then(([origin, rotation]) => ({ origin, rotation })),
	]);
	const intersections = {
		left: intersectHand(leftHandPose, panelPosition, panelRotation, panelScale),
		right: intersectHand(
			rightHandPose,
			panelPosition,
			panelRotation,
			panelScale,
		),
	};

	if (intersections.left === null && intersections.right === null) {
		runtime.preferredHand = null;
	} else if (intersections.left === null && intersections.right !== null) {
		runtime.preferredHand = "right";
	} else if (intersections.left !== null && intersections.right === null) {
		runtime.preferredHand = "left";
	} else {
		const other = runtime.preferredHand === "left" ? "right" : "left";
		if (intersections[other] && currentButtonValue(other, "trigger") > 0.5) {
			runtime.preferredHand = other;
		}
	}

	const hand = runtime.preferredHand;
	const hit = hand === null ? null : intersections[hand];
	runtime.cursorPosition = hit;
	io.MousePos.x = hit?.x ?? -Number.MAX_VALUE;
	io.MousePos.y = hit?.y ?? -Number.MAX_VALUE;
	io.MouseDown[0] = hand !== null && currentButtonValue(hand, "trigger") > 0.5;
	io.MouseDown[1] = hand !== null && currentButtonValue(hand, "grip") > 0.5;
	io.MouseDown[2] = false;
	const scrollAxis =
		hand === "left"
			? runtime.input.leftPrimaryAxis
			: runtime.input.rightPrimaryAxis;
	io.MouseWheel =
		hand !== null && Math.abs(scrollAxis[1]) > runtime.options.scrollDeadzone
			? scrollAxis[1] * runtime.options.scrollSpeed
			: 0;
	io.MouseWheelH = 0;
}

function renderCpu(drawData: ImGui.DrawData): void {
	clearFramebuffer();
	const displayPosX = drawData.DisplayPos.x;
	const displayPosY = drawData.DisplayPos.y;

	drawData.IterateDrawLists((drawList: ImGui.DrawList): void => {
		drawList.IterateDrawCmds((drawCmd: ImGui.DrawCmd): void => {
			if (drawCmd.UserCallback !== null) {
				//FIXME: todo custom ImDrawCmd callbacks are ignored by the software renderer.
				return;
			}

			const textureId =
				typeof drawCmd.TextureId === "number" ? drawCmd.TextureId : 0;
			const texture = getTexture(textureId);
			if (texture === null && textureId !== 0) {
				//FIXME: todo non-registered ImTextureID values cannot currently be sampled by the NodeJS software renderer.
			}

			const clipMinX = Math.max(0, drawCmd.ClipRect.x - displayPosX);
			const clipMinY = Math.max(0, drawCmd.ClipRect.y - displayPosY);
			const clipMaxX = Math.min(
				runtime.options.displayWidth,
				drawCmd.ClipRect.z - displayPosX,
			);
			const clipMaxY = Math.min(
				runtime.options.displayHeight,
				drawCmd.ClipRect.w - displayPosY,
			);
			if (clipMinX >= clipMaxX || clipMinY >= clipMaxY) {
				return;
			}

			const indexBuffer =
				ImGui.DrawIdxSize === 4
					? new Uint32Array(
							drawList.IdxBuffer.buffer,
							drawList.IdxBuffer.byteOffset +
								drawCmd.IdxOffset * ImGui.DrawIdxSize,
							drawCmd.ElemCount,
						)
					: new Uint16Array(
							drawList.IdxBuffer.buffer,
							drawList.IdxBuffer.byteOffset +
								drawCmd.IdxOffset * ImGui.DrawIdxSize,
							drawCmd.ElemCount,
						);

			for (let i = 0; i + 2 < indexBuffer.length; i += 3) {
				const i0 = indexBuffer[i + 0];
				const i1 = indexBuffer[i + 1];
				const i2 = indexBuffer[i + 2];
				const v0 = new ImGui.DrawVert(
					drawList.VtxBuffer.buffer as ArrayBuffer,
					drawList.VtxBuffer.byteOffset + i0 * ImGui.DrawVertSize,
				);
				const v1 = new ImGui.DrawVert(
					drawList.VtxBuffer.buffer as ArrayBuffer,
					drawList.VtxBuffer.byteOffset + i1 * ImGui.DrawVertSize,
				);
				const v2 = new ImGui.DrawVert(
					drawList.VtxBuffer.buffer as ArrayBuffer,
					drawList.VtxBuffer.byteOffset + i2 * ImGui.DrawVertSize,
				);
				rasterizeTriangle(
					v0,
					v1,
					v2,
					texture,
					clipMinX,
					clipMinY,
					clipMaxX,
					clipMaxY,
					displayPosX,
					displayPosY,
				);
			}
		});
	});
}

async function uploadFramebuffer(): Promise<void> {
	const width = runtime.options.displayWidth;
	const height = runtime.options.displayHeight;
	const rowSize = width * 4;
	for (let y = 0; y < height; y++) {
		const sourceOffset = y * rowSize;
		const targetOffset = (height - 1 - y) * rowSize;
		runtime.uploadBuffer.set(
			runtime.framebuffer.subarray(sourceOffset, sourceOffset + rowSize),
			targetOffset,
		);
	}
	await runtime.outputTexture.uploadRGBA(runtime.uploadBuffer);
}

export async function Init(options: AdamasInitOptions | null): Promise<void> {
	if (options === null) {
		throw new Error("imgui_impl_adamas_node.Init requires a targetEntity");
	}
	if (runtimeReady && !runtime.shutdown) {
		return;
	}
	if (initPromise !== null) {
		await initPromise;
		return;
	}

	initPromise = (async () => {
		const nextRuntime = await createRuntime(options);
		const io = ImGui.GetIO();
		io.BackendPlatformName = "imgui_impl_adamas";
		io.BackendRendererName = "imgui_impl_adamas_node_rgba";
		io.DisplaySize.x = nextRuntime.options.displayWidth;
		io.DisplaySize.y = nextRuntime.options.displayHeight;
		io.DisplayFramebufferScale.x = 1;
		io.DisplayFramebufferScale.y = 1;
		io.SetClipboardTextFn = (_userData: unknown, text: string): void => {
			clipboardText = text;
			//FIXME: todo clipboard integration is in-memory only because the Adamas SDK typings do not expose a platform clipboard API.
		};
		io.GetClipboardTextFn = (): string => clipboardText;
		io.ClipboardUserData = null;
		//FIXME: todo keyboard input is not wired because the current public Adamas device API only exposes controller-style inputs.

		runtime = nextRuntime;
		runtimeReady = true;
	})().catch((error) => {
		console.error("imgui_impl_adamas init failed", error);
		throw error;
	});

	try {
		await initPromise;
	} finally {
		initPromise = null;
	}
}

export function Shutdown(): void {
	if (!runtimeReady) {
		return;
	}
	const state = runtime;
	runtimeReady = false;
	state.shutdown = true;
	const subscriptions = [...state.subscriptions];
	state.subscriptions = [];
	void Promise.all(
		subscriptions.map((subscription) =>
			Device.UnsubscribeValueChange(subscription).catch(() => false),
		),
	)
		.then(async () => {
			await state.outputTexture.close().catch(() => false);
			await MaterialManager.Destroy(state.targetMaterial).catch(() => false);
			state.textureRegistry.clear();
		})
		.catch((error) => {
			console.error("imgui_impl_adamas shutdown failed", error);
		});
}

export async function NewFrame(time: number): Promise<void> {
	const io = ImGui.GetIO();
	if (!runtimeReady) {
		io.MousePos.x = -Number.MAX_VALUE;
		io.MousePos.y = -Number.MAX_VALUE;
		io.MouseDown[0] = false;
		io.MouseDown[1] = false;
		io.MouseDown[2] = false;
		io.MouseWheel = 0;
		io.MouseWheelH = 0;
		return;
	}

	io.DisplaySize.x = runtime.options.displayWidth;
	io.DisplaySize.y = runtime.options.displayHeight;
	io.DisplayFramebufferScale.x = 1;
	io.DisplayFramebufferScale.y = 1;
	io.DeltaTime = computeDeltaTime(time);

	if (!runtime.shutdown) {
		await updateMouseFromHands();
	}
}

export async function RenderDrawData(): Promise<void> {
	if (!runtimeReady || runtime.shutdown) {
		return;
	}
	drawCursorDot();
	ImGui.Render();
	const drawData = ImGui.GetDrawData();
	if (drawData === null) {
		return;
	}
	renderCpu(drawData);
	await uploadFramebuffer();
}
