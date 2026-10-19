"use client";

import { Check, KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type ConfigInfo,
	type ModelInfo,
	type ProviderAccountInfo,
	type ProviderPresetInfo,
	addAccountModels,
	editAccountModel,
	createAccount,
	deleteAccount,
	deleteAccountModel,
	editAccount,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

const FALLBACK_PRESETS: ProviderPresetInfo[] = [
	{ id: "anthropic", display_name: "Anthropic", type: "anthropic", default_base_url: "https://api.anthropic.com", requires_api_key: true },
	{ id: "openai", display_name: "OpenAI", type: "openai", default_base_url: "https://api.openai.com/v1", requires_api_key: true },
	{ id: "openrouter", display_name: "OpenRouter", type: "openai", default_base_url: "https://openrouter.ai/api/v1", requires_api_key: true },
	{ id: "deepseek", display_name: "DeepSeek", type: "openai", default_base_url: "https://api.deepseek.com/v1", requires_api_key: true },
	{ id: "openai-compatible", display_name: "OpenAI-compatible", type: "openai", default_base_url: "", requires_api_key: false },
];

type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; account: ProviderAccountInfo };

const inputClass =
	"h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30";

export function ProviderSettings({
	config,
	models,
	provider,
	onProvider,
	onRefresh,
}: {
	config: ConfigInfo | null;
	models: ModelInfo[];
	provider: string;
	onProvider: (provider: string) => void;
	onRefresh: () => Promise<void>;
}) {
	const [mode, setMode] = useState<Mode>({ kind: "list" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const accounts = config?.provider_accounts ?? [];
	const enabledPatterns = config?.enabled_models ?? [];
	const presets = useMemo(() => {
		const list = [...(config?.provider_presets ?? []), ...(config?.provider_protocols ?? [])];
		return list.length > 0 ? list : FALLBACK_PRESETS;
	}, [config?.provider_presets, config?.provider_protocols]);

	async function act(run: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await run();
			await onRefresh();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	if (mode.kind === "add") {
		return (
			<AddProviderForm
				presets={presets}
				busy={busy}
				error={error}
				onCancel={() => setMode({ kind: "list" })}
				onSubmit={(body) =>
					act(async () => {
						await createAccount(body);
						setMode({ kind: "list" });
					})
				}
			/>
		);
	}

	if (mode.kind === "edit") {
		return (
			<EditProviderForm
				account={mode.account}
				models={models}
				busy={busy}
				error={error}
				onBack={() => setMode({ kind: "list" })}
				onSave={(body) =>
					act(async () => {
						await editAccount(mode.account.id, body);
					})
				}
				onAddModel={(model) =>
					act(async () => {
						await addAccountModels(mode.account.id, [model]);
					})
				}
				onDeleteModel={(modelId) =>
					act(async () => {
						await deleteAccountModel(mode.account.id, modelId);
					})
				}
				onEffort={(modelId, effort) =>
					act(async () => {
						await editAccountModel(mode.account.id, modelId, {
							...(effort ? { reasoning_effort: effort } : { clear_reasoning_effort: true }),
						});
					})
				}
			/>
		);
	}

	return (
		<div>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h1 className="text-[18px] font-semibold tracking-[-0.02em]">{t('模型')}</h1>
					<p className="mt-1 text-[12.5px] text-muted-foreground">
						{t("管理模型 provider 和 API key。保存后立即出现在 composer 的模型选择器中。")}
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						setError(null);
						setMode({ kind: "add" });
					}}
					className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-2.5 text-[12px] font-medium text-background transition-opacity hover:opacity-85"
				>
					<Plus className="size-3.5" />
					{t("添加 Provider")}
				</button>
			</div>

			{error ? <p className="mt-3 text-[11.5px] text-destructive">{error}</p> : null}

			{models.length > 0 ? (
				<div className="mt-4">
					<h2 className="text-[12px] font-medium text-muted-foreground">{t('当前使用')}</h2>
					{enabledPatterns.length > 0 ? (
						<p className="mt-1 text-[11px] text-muted-foreground">
							{t("CLI 的 enabledModels 已限定模型范围，选择器只列出匹配的模型。")}
						</p>
					) : null}
					<div className="mt-1.5 overflow-hidden rounded-xl border border-border">
						{models.map((model, index) => (
							<button
								key={model.provider}
								type="button"
								onClick={() => onProvider(model.provider)}
								className={cn(
									"flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-overlay-hover",
									index > 0 && "border-t border-border-soft",
								)}
							>
								<span className="grid size-4 shrink-0 place-items-center">
									{model.provider === provider ? <Check className="size-3.5 text-brand" /> : null}
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[12.5px] text-foreground">{model.model}</span>
									<span className="block truncate text-[10.5px] text-muted-foreground">
										{model.provider} · {model.provider_type}
									</span>
								</span>
							</button>
						))}
					</div>
				</div>
			) : null}

			<h2 className="mt-6 text-[12px] font-medium text-muted-foreground">Providers</h2>
			<div className="mt-2 space-y-2">
				{accounts.length === 0 ? (
					<div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
						<p className="text-[12.5px] text-muted-foreground">{t('还没有 Provider')}</p>
						<p className="mt-1 text-[11px] text-muted-foreground/70">
							{t("添加一个 provider 和模型后即可开始对话。")}
						</p>
					</div>
				) : (
					accounts.map((account) => (
						<AccountCard
							key={account.id}
							account={account}
							models={models}
							busy={busy}
							onEdit={() => {
								setError(null);
								setMode({ kind: "edit", account });
							}}
							onDelete={() =>
								act(async () => {
									await deleteAccount(account.id);
								})
							}
						/>
					))
				)}
			</div>
		</div>
	);
}

/**
 * Models of this account the runtime will not offer, i.e. unavailable entries
 * reported for the same provider id. The CLI drops them too when the provider
 * resolves no credential, so the card marks them instead of implying they chat.
 */
function unusableModels(account: ProviderAccountInfo, models: ModelInfo[]): string[] {
	const usable = new Set(
		models.filter((model) => model.provider_type === account.id && model.available).map((model) => model.model),
	);
	return account.model_ids.filter((model) => !usable.has(model));
}

function AccountCard({
	account,
	models,
	busy,
	onEdit,
	onDelete,
}: {
	account: ProviderAccountInfo;
	models: ModelInfo[];
	busy: boolean;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const unusable = unusableModels(account, models);

	return (
		<div className="rounded-xl border border-border p-3">
			<div className="flex items-start gap-3">
				<span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
					<KeyRound className="size-4" strokeWidth={1.75} />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span className="text-[13px] font-medium text-foreground">
							{account.label || account.display_name || account.id}
						</span>
						<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
							{account.provider}
						</span>
						{account.has_api_key ? (
							<span className="inline-flex items-center gap-0.5 text-[10px] text-success">
								<Check className="size-3" />
								{t("已保存密钥")}
							</span>
						) : (
							<span className="text-[10px] text-muted-foreground">{t('无密钥')}</span>
						)}
						{account.managed ? (
							<span className="text-[10px] text-muted-foreground">{t('受管理')}</span>
						) : null}
						{unusable.length > 0 ? (
							<span className="text-[10px] text-muted-foreground">{t("未配置凭证")}</span>
						) : null}
					</div>
					{account.base_url ? (
						<p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
							{account.base_url}
						</p>
					) : null}
					<div className="mt-2 flex flex-wrap gap-1">
						{account.model_ids.length === 0 ? (
							<span className="text-[11px] text-muted-foreground">{t('暂无模型')}</span>
						) : (
							account.model_ids.map((model) => (
								<span
									key={model}
									className={cn(
										"rounded-full border border-border-soft bg-muted/40 px-2 py-0.5 font-mono text-[10.5px] text-foreground/75",
										unusable.includes(model) && "text-muted-foreground line-through",
									)}
								>
									{model}
								</span>
							))
						)}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						onClick={onEdit}
						disabled={busy}
						className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-overlay-hover hover:text-foreground disabled:opacity-40"
						aria-label={t("编辑")}
						title={t("编辑")}
					>
						<Pencil className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => setConfirming(true)}
						disabled={busy || account.managed}
						className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
						aria-label={t("删除")}
						title={t("删除")}
					>
						<Trash2 className="size-3.5" />
					</button>
				</div>
			</div>

			{confirming ? (
				<div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2">
					<span className="text-[11.5px] text-destructive">
						{t("删除")} {account.label || account.id} {t("及其全部模型？")}
					</span>
					<span className="flex shrink-0 items-center gap-1">
						<button
							type="button"
							onClick={() => setConfirming(false)}
							className="h-7 rounded-md px-2 text-[11.5px] text-muted-foreground hover:bg-overlay-hover hover:text-foreground"
						>
							{t("取消")}
						</button>
						<button
							type="button"
							onClick={onDelete}
							disabled={busy}
							className="h-7 rounded-md bg-destructive px-2 text-[11.5px] font-medium text-white disabled:opacity-50"
						>
							{t("删除")}
						</button>
					</span>
				</div>
			) : null}
		</div>
	);
}

function AddProviderForm({
	presets,
	busy,
	error,
	onCancel,
	onSubmit,
}: {
	presets: ProviderPresetInfo[];
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSubmit: (body: {
		provider: string;
		display_name?: string;
		base_url?: string;
		api_key?: string;
		models: { model: string; display_name?: string }[];
	}) => void;
}) {
	const [presetId, setPresetId] = useState(presets[0]?.id ?? "openai");
	const preset = presets.find((item) => item.id === presetId) ?? presets[0];
	const [displayName, setDisplayName] = useState("");
	const [baseUrl, setBaseUrl] = useState(preset?.default_base_url ?? "");
	const [apiKey, setApiKey] = useState("");
	const [model, setModel] = useState("");
	const [modelName, setModelName] = useState("");

	useEffect(() => {
		setBaseUrl(preset?.default_base_url ?? "");
	}, [preset?.default_base_url]);

	return (
		<SettingsSubpage title={t("添加 Provider")} onBack={onCancel}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (!model.trim() || busy) return;
					onSubmit({
						provider: presetId,
						display_name: displayName.trim() || undefined,
						base_url: baseUrl.trim() || undefined,
						api_key: apiKey.trim() || undefined,
						models: [{ model: model.trim(), display_name: modelName.trim() || undefined }],
					});
				}}
				className="space-y-4"
			>
				<Field label={t("服务商")}>
					<select
						value={presetId}
						onChange={(event) => setPresetId(event.target.value)}
						className={inputClass}
					>
						{presets.map((item) => (
							<option key={item.id} value={item.id}>
								{item.display_name} ({item.type})
							</option>
						))}
					</select>
				</Field>

				<Field label={t("名称")} hint={t("可选，例如“公司网关”")}>
					<input
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						placeholder={preset?.display_name ?? "Provider"}
						className={inputClass}
					/>
				</Field>

				<Field label="Base URL" hint={t("留空使用服务商默认地址")}>
					<input
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder={preset?.default_base_url ?? "https://..."}
						className={inputClass}
					/>
				</Field>

				<Field label="API Key" hint={preset?.requires_api_key ? t("必填") : t("可选")}>
					<input
						type="password"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder="sk-..."
						autoComplete="off"
						className={inputClass}
					/>
				</Field>

				<div className="grid gap-3 sm:grid-cols-2">
					<Field label={t("模型 ID")} hint={t("例如 claude-sonnet-4")}>
						<input
							value={model}
							onChange={(event) => setModel(event.target.value)}
							placeholder="model-id"
							className={inputClass}
						/>
					</Field>
					<Field label={t("模型显示名")} hint={t("可选")}>
						<input
							value={modelName}
							onChange={(event) => setModelName(event.target.value)}
							placeholder="Claude Sonnet 4"
							className={inputClass}
						/>
					</Field>
				</div>

				{error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}

				<div className="flex items-center justify-end gap-1.5 pt-1">
					<button
						type="button"
						onClick={onCancel}
						className="h-8 rounded-lg px-2.5 text-[12px] text-muted-foreground hover:bg-overlay-hover hover:text-foreground"
					>
						{t("取消")}
					</button>
					<button
						type="submit"
						disabled={busy || !model.trim()}
						className="h-8 rounded-lg bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
					>
						{busy ? t("保存中…") : t("保存")}
					</button>
				</div>
			</form>
		</SettingsSubpage>
	);
}

function EditProviderForm({
	account,
	models,
	busy,
	error,
	onBack,
	onSave,
	onAddModel,
	onDeleteModel,
	onEffort,
}: {
	account: ProviderAccountInfo;
	models: ModelInfo[];
	busy: boolean;
	error: string | null;
	onBack: () => void;
	onSave: (body: { display_name?: string; base_url?: string; api_key?: string }) => void;
	onAddModel: (model: { model: string; display_name?: string }) => void;
	onDeleteModel: (modelId: string) => void;
	onEffort: (modelId: string, effort: string) => void;
}) {
	const [displayName, setDisplayName] = useState(account.display_name ?? "");
	const [baseUrl, setBaseUrl] = useState(account.base_url ?? "");
	const [apiKey, setApiKey] = useState("");
	const unusable = unusableModels(account, models);
	const [newModel, setNewModel] = useState("");
	const [newModelName, setNewModelName] = useState("");

	return (
		<SettingsSubpage title={account.label || account.id} onBack={onBack}>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (busy) return;
					onSave({
						display_name: displayName.trim() || undefined,
						base_url: baseUrl.trim() || undefined,
						api_key: apiKey.trim() || undefined,
					});
					setApiKey("");
				}}
				className="space-y-3"
			>
				<Field label={t("名称")}>
					<input
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
						placeholder={account.id}
						className={inputClass}
					/>
				</Field>
				<Field label="Base URL">
					<input
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder={account.base_url || t("默认地址")}
						className={inputClass}
					/>
				</Field>
				<Field label="API Key" hint={account.has_api_key ? t("已保存；留空保持不变") : t("尚未设置")}>
					<input
						type="password"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={t("留空保持不变")}
						autoComplete="off"
						className={inputClass}
					/>
				</Field>
				<div className="flex justify-end pt-1">
					<button
						type="submit"
						disabled={busy}
						className="h-8 rounded-lg bg-foreground px-3 text-[12px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-40"
					>
						{busy ? t("保存中…") : t("保存修改")}
					</button>
				</div>
			</form>

			<div className="mt-6">
				<h3 className="text-[12.5px] font-medium">{t('模型')}</h3>
				{unusable.length > 0 ? (
					<p className="mt-1 text-[11px] text-muted-foreground">
						{t("划掉的模型未配置凭证，不会出现在模型选择器里。")}
					</p>
				) : null}
				<div className="mt-2 space-y-1">
					{account.model_ids.length === 0 ? (
						<p className="text-[11.5px] text-muted-foreground">{t('还没有模型')}</p>
					) : (
						account.model_ids.map((modelId) => (
							<div
								key={modelId}
								className="flex items-center gap-2 rounded-lg border border-border-soft px-2.5 py-1.5"
							>
								<span
									className={cn(
										"min-w-0 flex-1 truncate font-mono text-[11.5px]",
										unusable.includes(modelId) && "text-muted-foreground line-through",
									)}
								>
									{modelId}
								</span>
								<button
									type="button"
									onClick={() => onDeleteModel(modelId)}
									disabled={busy}
									aria-label={`${t("删除模型")} ${modelId}`}
									className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
								>
									<X className="size-3.5" />
								</button>
							</div>
						))
					)}
				</div>

				<div className="mt-3 flex flex-wrap items-end gap-2">
					<div className="min-w-[160px] flex-1">
						<Field label={t("添加模型")}>
							<input
								value={newModel}
								onChange={(event) => setNewModel(event.target.value)}
								placeholder="model-id"
								className={inputClass}
							/>
						</Field>
					</div>
					<div className="min-w-[140px] flex-1">
						<Field label={t("显示名")}>
							<input
								value={newModelName}
								onChange={(event) => setNewModelName(event.target.value)}
								placeholder={t("可选")}
								className={inputClass}
							/>
						</Field>
					</div>
					<button
						type="button"
						disabled={busy || !newModel.trim()}
						onClick={() => {
							onAddModel({
								model: newModel.trim(),
								display_name: newModelName.trim() || undefined,
							});
							setNewModel("");
							setNewModelName("");
						}}
						className="h-9 shrink-0 rounded-lg border border-border px-2.5 text-[12px] text-foreground transition-colors hover:bg-overlay-hover disabled:opacity-40"
					>
						{t("添加")}
					</button>
				</div>
			</div>

			{error ? <p className="mt-3 text-[11.5px] text-destructive">{error}</p> : null}
		</SettingsSubpage>
	);
}

function SettingsSubpage({
	title,
	onBack,
	children,
}: {
	title: string;
	onBack: () => void;
	children: React.ReactNode;
}) {
	return (
		<div>
			<button
				type="button"
				onClick={onBack}
				className="inline-flex h-7 items-center gap-1 rounded-md pr-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
			>
				{t("← 返回")}
			</button>
			<h1 className="mt-1 text-[18px] font-semibold tracking-[-0.02em]">{title}</h1>
			<div className="mt-4">{children}</div>
		</div>
	);
}

function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<label className="block">
			<span className="mb-1 flex items-baseline gap-1.5">
				<span className="text-[11.5px] font-medium text-foreground">{label}</span>
				{hint ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
			</span>
			{children}
		</label>
	);
}
