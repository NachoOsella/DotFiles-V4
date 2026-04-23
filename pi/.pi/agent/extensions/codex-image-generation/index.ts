import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	getEnvApiKey,
	Type,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Box, Image, Spacer, Text } from "@mariozechner/pi-tui";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "/usr/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/providers/openai-responses-shared.js";

const PROVIDER = "openai-codex";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const IMAGE_DIR = ".pi/openai-codex-images";
const LATEST_IMAGE_NAME = "latest.png";
const IMAGE_TOOL_NAME = "image_generation";
const LOCAL_IMAGE_TOOL_NAME = "generate_image_codex";
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const IMAGE_GENERATION_UNSUPPORTED_MESSAGE = "image_generation is only available with image-capable openai-codex models";
const IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE = "image_generation is a native openai-codex provider tool and should not execute locally";
const IMAGE_TOOL_PARAMETERS = Type.Object({}, { additionalProperties: false });
const LOCAL_IMAGE_TOOL_PARAMETERS = Type.Object({
	prompt: Type.String({ description: "Detailed prompt for the image to generate." }),
	style: Type.Optional(Type.String({ description: "Optional visual style guidance, e.g. 'minimalist SaaS landing page'." })),
	aspectRatio: Type.Optional(Type.String({ description: "Optional aspect ratio hint, e.g. 16:9, 4:3, 1:1." })),
});
const IMAGE_MESSAGE_TYPE = "codex-image-generation-display";

interface FunctionToolPayload {
	type?: unknown;
	name?: unknown;
}

interface ResponsesPayload {
	tools?: unknown[];
	[key: string]: unknown;
}

interface SavedImage {
	absolutePath: string;
	relativePath: string;
	latestAbsolutePath: string;
	latestRelativePath: string;
	responseId?: string;
	callId: string;
	outputFormat: string;
	revisedPrompt?: string;
}

interface CachedImagePreview {
	data: string;
	mimeType: string;
}

interface PendingPromptedImageRequest {
	prompt: string;
	style?: string;
	aspectRatio?: string;
}

interface StreamEventShape {
	type?: string;
	response?: { id?: string; status?: string; error?: { message?: string } };
	item?: {
		id?: string;
		type?: string;
		result?: string | null;
		output_format?: string;
		revised_prompt?: string;
		status?: string;
		[key: string]: unknown;
	};
	code?: string;
	message?: string;
	[key: string]: unknown;
}

function supportsNativeImageGeneration(model: ExtensionContext["model"] | Model<any> | undefined): boolean {
	return (model?.provider ?? "") === PROVIDER && Array.isArray(model?.input) && model.input.includes("image");
}

function isImageGenerationFunctionTool(tool: unknown): tool is FunctionToolPayload {
	return !!tool && typeof tool === "object" && (tool as FunctionToolPayload).type === "function" && (tool as FunctionToolPayload).name === IMAGE_TOOL_NAME;
}

function rewriteNativeImageGenerationTool(payload: unknown, model: ExtensionContext["model"] | Model<any> | undefined): unknown {
	if (!supportsNativeImageGeneration(model) || !payload || typeof payload !== "object") {
		return payload;
	}

	const tools = (payload as ResponsesPayload).tools;
	if (!Array.isArray(tools)) {
		return payload;
	}

	let rewritten = false;
	const nextTools = tools.map((tool) => {
		if (!isImageGenerationFunctionTool(tool)) return tool;
		rewritten = true;
		return { type: "image_generation", output_format: "png" };
	});

	return rewritten ? { ...(payload as ResponsesPayload), tools: nextTools } : payload;
}

function createImageGenerationTool(): ToolDefinition<typeof IMAGE_TOOL_PARAMETERS> {
	const description =
		"Generate an image. Native openai-codex image_generation outputs are saved under `.pi/openai-codex-images/` and mirrored to `.pi/openai-codex-images/latest.png`.";
	return {
		name: IMAGE_TOOL_NAME,
		label: IMAGE_TOOL_NAME,
		description,
		promptSnippet: description,
		parameters: IMAGE_TOOL_PARAMETERS,
		prepareArguments: () => ({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!supportsNativeImageGeneration(ctx.model)) {
				throw new Error(IMAGE_GENERATION_UNSUPPORTED_MESSAGE);
			}
			throw new Error(IMAGE_GENERATION_LOCAL_EXECUTION_MESSAGE);
		},
	};
}

function createPromptedImageTool(
	getCurrentCwd: () => string,
	onImageSaved: (savedImage: SavedImage) => void,
): ToolDefinition<typeof LOCAL_IMAGE_TOOL_PARAMETERS> {
	return {
		name: LOCAL_IMAGE_TOOL_NAME,
		label: "Generate image with Codex",
		description:
			"Generate an image through the Codex backend using a rich prompt you provide here. Use this when you want the assistant to write a strong image prompt and invoke generation directly.",
		promptSnippet:
			"Generate an image through Codex when the user asks for a visual artifact and you should craft the prompt yourself.",
		parameters: LOCAL_IMAGE_TOOL_PARAMETERS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model ?? ctx.modelRegistry.find(PROVIDER, "gpt-5.4");
			if (!model || model.provider !== PROVIDER) {
				throw new Error("Seleccioná un modelo openai-codex para usar generate_image_codex.");
			}
			onUpdate?.({ content: [{ type: "text", text: `Generating image with ${PROVIDER}/${model.id}...` }] });
			const promptParts = [params.prompt];
			if (params.style?.trim()) promptParts.push(`Style: ${params.style.trim()}`);
			if (params.aspectRatio?.trim()) promptParts.push(`Aspect ratio: ${params.aspectRatio.trim()}`);
			const requestPrompt = promptParts.join("\n");
			const { savedImage } = await generateSingleImage(ctx, model, requestPrompt, getCurrentCwd(), signal);
			onImageSaved(savedImage);
			return {
				content: [
					{ type: "text", text: `Generated image saved to ${savedImage.relativePath}. Latest mirror: ${savedImage.latestRelativePath}.` },
				],
				details: savedImage,
			};
		},
	};
}

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract chatgpt_account_id from openai-codex token");
	}
}

function resolveCodexUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function buildHeaders(
	modelHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	apiKey: string,
	accountId: string,
	sessionId: string | undefined,
): Headers {
	const headers = new Headers(modelHeaders);
	for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${apiKey}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}

function getLatestUserText(context: Context): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i -= 1) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			const trimmed = message.content.trim();
			if (trimmed) return trimmed;
			continue;
		}
		const text = message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

function buildRequestBody(model: Model<any>, context: Context, options?: SimpleStreamOptions): Record<string, unknown> {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, { includeSystemPrompt: false });
	const body: Record<string, unknown> = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt,
		input: messages,
		text: { verbosity: "medium" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.sessionId,
		tool_choice: "auto",
		parallel_tool_calls: true,
	};
	if (options?.temperature !== undefined) body.temperature = options.temperature;
	if (context.tools) body.tools = convertResponsesTools(context.tools, { strict: null });
	return body;
}

async function* parseSSE(response: Response): AsyncIterable<StreamEventShape> {
	if (!response.body) return;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				const dataLines = chunk
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as StreamEventShape;
						} catch {
							// ignore malformed event
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

async function findWorkspaceRoot(startCwd: string): Promise<string> {
	let current = startCwd;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return startCwd;
		current = parent;
	}
}

async function saveGeneratedImage(
	cwd: string,
	image: { responseId?: string; callId: string; result: string; outputFormat?: string; revisedPrompt?: string },
): Promise<SavedImage> {
	const workspaceRoot = await findWorkspaceRoot(cwd);
	const outputFormat = (image.outputFormat ?? "png").toLowerCase();
	const dir = join(workspaceRoot, IMAGE_DIR);
	const filename = `${image.callId.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${(image.responseId ?? randomUUID()).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 24)}.${outputFormat}`;
	const absolutePath = join(dir, filename);
	const latestAbsolutePath = join(dir, LATEST_IMAGE_NAME);
	const bytes = Buffer.from(image.result, "base64");
	await mkdir(dir, { recursive: true });
	await writeFile(absolutePath, bytes);
	await writeFile(latestAbsolutePath, bytes);
	const relativePathValue = relative(workspaceRoot, absolutePath) || absolutePath;
	const latestRelativePathValue = relative(workspaceRoot, latestAbsolutePath) || latestAbsolutePath;
	return {
		absolutePath,
		relativePath: relativePathValue,
		latestAbsolutePath,
		latestRelativePath: latestRelativePathValue,
		responseId: image.responseId,
		callId: image.callId,
		outputFormat,
		revisedPrompt: image.revisedPrompt,
	};
}

async function* tapImageEvents(
	events: AsyncIterable<StreamEventShape>,
	options: { cwd: string; requestPrompt?: string; onImageSaved: (savedImage: SavedImage) => void },
): AsyncIterable<ResponseStreamEvent> {
	let responseId: string | undefined;
	for await (const event of events) {
		if (event.type === "error") {
			throw new Error(`Codex error: ${event.message || event.code || "unknown error"}`);
		}
		if (event.type === "response.failed") {
			throw new Error(event.response?.error?.message || "Codex response failed");
		}
		if (event.type === "response.created" && event.response?.id) {
			responseId = event.response.id;
		}
		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			const callId = typeof event.item.id === "string" ? event.item.id : undefined;
			const result = typeof event.item.result === "string" ? event.item.result : undefined;
			if (callId && result) {
				const saved = await saveGeneratedImage(options.cwd, {
					responseId,
					callId,
					result,
					outputFormat: typeof event.item.output_format === "string" ? event.item.output_format : undefined,
					revisedPrompt: typeof event.item.revised_prompt === "string" ? event.item.revised_prompt : options.requestPrompt,
				});
				options.onImageSaved(saved);
			}
		}
		yield event as ResponseStreamEvent;
	}
}

function createInitialAssistantMessage(model: Model<any>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createErrorMessage(message: AssistantMessage, error: unknown, aborted: boolean): AssistantMessage {
	for (const block of message.content) {
		if (typeof block === "object" && block !== null && "partialJson" in block) {
			delete (block as { partialJson?: string }).partialJson;
		}
	}
	message.stopReason = aborted ? "aborted" : "error";
	message.errorMessage = error instanceof Error ? error.message : String(error);
	return message;
}

function finalizeUsage(output: AssistantMessage): void {
	output.usage.cost.total = output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead + output.usage.cost.cacheWrite;
}

async function resolveApiKeyFromContext(ctx: ExtensionContext, model: Model<any>): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok && auth.apiKey) return auth.apiKey;
	if (!auth.ok) throw new Error(auth.error);
	const fallback = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
	if (fallback) return fallback;
	throw new Error(`No API key for provider: ${model.provider}`);
}

async function generateSingleImage(
	ctx: ExtensionContext,
	model: Model<any>,
	requestPrompt: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ savedImage: SavedImage }> {
	const apiKey = await resolveApiKeyFromContext(ctx, model);
	const accountId = extractAccountId(apiKey);
	const body = {
		model: model.id,
		store: false,
		stream: true,
		instructions: "You are an AI image generator.",
		input: [{ role: "user", content: [{ type: "input_text", text: requestPrompt }] }],
		text: { verbosity: "medium" },
		include: ["reasoning.encrypted_content"],
		tool_choice: "auto",
		parallel_tool_calls: true,
		tools: [{ type: "image_generation", output_format: "png" }],
	};
	const response = await fetch(resolveCodexUrl(model.baseUrl), {
		method: "POST",
		headers: buildHeaders(model.headers, undefined, apiKey, accountId, undefined),
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw new Error(await response.text());
	let savedImage: SavedImage | undefined;
	for await (const event of tapImageEvents(parseSSE(response), {
		cwd,
		requestPrompt,
		onImageSaved: (image) => {
			savedImage = image;
		},
	})) {
		if (event.type === "response.completed") break;
	}
	if (!savedImage) throw new Error("Codex no devolvió una imagen.");
	return { savedImage };
}

function createCodexStream(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	deps: { getCurrentCwd: () => string; onImageSaved: (savedImage: SavedImage) => void },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output = createInitialAssistantMessage(model);
		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const accountId = extractAccountId(apiKey);
			let body = buildRequestBody(model, context, options);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) body = nextBody as Record<string, unknown>;
			const response = await fetch(resolveCodexUrl(model.baseUrl), {
				method: "POST",
				headers: buildHeaders(model.headers, options?.headers, apiKey, accountId, options?.sessionId),
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
			if (!response.ok) {
				throw new Error(await response.text());
			}
			if (!response.body) throw new Error("No response body");
			stream.push({ type: "start", partial: output });
			await processResponsesStream(
				tapImageEvents(parseSSE(response), {
					cwd: deps.getCurrentCwd(),
					requestPrompt: getLatestUserText(context),
					onImageSaved: deps.onImageSaved,
				}),
				output,
				stream,
				model,
			);
			finalizeUsage(output);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: (options?.signal?.aborted ? "aborted" : "error") as "aborted" | "error",
				error: createErrorMessage(output, error, !!options?.signal?.aborted),
			});
			stream.end();
		}
	})();
	return stream;
}

export default function codexImageGeneration(pi: ExtensionAPI): void {
	let currentCwd = process.cwd();
	const pendingImages: SavedImage[] = [];
	const imagePreviewCache = new Map<string, CachedImagePreview>();

	const emitImageMessage = (image: SavedImage) => {
		try {
			imagePreviewCache.set(image.absolutePath, {
				data: readFileSync(image.absolutePath).toString("base64"),
				mimeType: `image/${image.outputFormat}`,
			});
		} catch {}
		pi.sendMessage({
			customType: IMAGE_MESSAGE_TYPE,
			content: `Generated image saved to ${image.relativePath}. Latest mirror: ${image.latestRelativePath}.`,
			display: true,
			details: image,
		});
	};

	const flushPendingImages = () => {
		while (pendingImages.length > 0) {
			emitImageMessage(pendingImages.shift() as SavedImage);
		}
	};

	pi.registerProvider(PROVIDER, {
		api: "openai-codex-responses",
		streamSimple: (model, context, streamOptions) =>
			createCodexStream(model, context, streamOptions, {
				getCurrentCwd: () => currentCwd,
				onImageSaved: (savedImage) => {
					pendingImages.push(savedImage);
				},
			}),
	});

	pi.registerTool(createImageGenerationTool());
	pi.registerTool(
		createPromptedImageTool(() => currentCwd, (savedImage) => {
			pendingImages.push(savedImage);
			flushPendingImages();
		}),
	);

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		pendingImages.length = 0;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		currentCwd = ctx.cwd;
		if ((ctx.model?.provider ?? "") !== PROVIDER) return undefined;
		return rewriteNativeImageGenerationTool(event.payload, ctx.model);
	});

	pi.on("agent_end", async () => {
		flushPendingImages();
	});

	pi.registerMessageRenderer<SavedImage>(IMAGE_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const image = message.details as SavedImage | undefined;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[image_generation]")), 0, 0));
		if (!image) {
			box.addChild(new Text(`\n${theme.fg("customMessageText", String(message.content))}`, 0, 0));
			return box;
		}

		const lines = [`File: ${image.relativePath}`, `Latest: ${image.latestRelativePath}`];
		if (expanded && image.revisedPrompt) {
			lines.unshift(`Prompt: ${image.revisedPrompt}`);
		}
		box.addChild(new Text(`\n${theme.fg("customMessageText", lines.join("\n"))}`, 0, 0));

		const preview = imagePreviewCache.get(image.absolutePath);
		if (preview) {
			box.addChild(new Spacer(1));
			box.addChild(
				new Image(preview.data, preview.mimeType, { fallbackColor: (text) => theme.fg("customMessageText", text) }, { maxWidthCells: 60 }),
			);
		}
		return box;
	});
}
