import { useId, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { observer } from "mobx-react-lite";
import { usePersistCallback } from "@multica/ui/hooks/use-persist-callback";
import { Bot, Check, Command, Search } from "lucide-react";
import { activateModelPickerShortcut } from "./model-picker-shortcut";
import { Button } from "@multica/ui/components/ui/button";
import type {
  RuntimeModelsResult,
  RuntimeModelThinkingLevel
} from "@multica/core/types";

interface Props {
  chinese: boolean;
  catalog: RuntimeModelsResult | null;
  selected: string | null;
  configured: string | null;
  selectedEffort: string | null;
  modelLabel: string;
  defaultModel?: string;
  levels: RuntimeModelThinkingLevel[];
  effortLabel(value: string, fallback: string): string;
  disabled: boolean;
  loading: boolean;
  error: string | null;
  labels: Record<
    | "model"
    | "default"
    | "loading"
    | "retry"
    | "refresh"
    | "empty"
    | "unsupported"
    | "unknown"
    | "modelScope",
    string
  >;
  noReasoningOptions: string;
  onModelChange(value: string): Promise<void>;
  onEffortChange(value: string): Promise<void>;
  onReload(force?: boolean): Promise<void>;
  remote: boolean;
}

export const ModelReasoningPanel = observer(ModelReasoningPanelRender);

function ModelReasoningPanelRender({
  chinese,
  catalog,
  selected,
  configured,
  selectedEffort,
  modelLabel,
  defaultModel,
  levels,
  effortLabel,
  disabled,
  loading,
  error,
  labels,
  noReasoningOptions,
  onModelChange,
  onEffortChange,
  onReload,
  remote
}: Props) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const copy = chinese
    ? {
        search: "搜索模型...",
        more: "显示更多",
        less: "收起",
        noMatches: "没有匹配的模型",
        reasoning: "推理强度",
        inherit: "沿用 CLI 设置",
        builtIn: "CLI 内置默认",
        builtInHelp: "CLI 配置可能覆盖此内置默认值。"
      }
    : {
        search: "Search models...",
        more: "Show more",
        less: "Show less",
        noMatches: "No matching models",
        reasoning: "Reasoning",
        inherit: "Use CLI settings",
        builtIn: "CLI default",
        builtInHelp: "Local CLI settings may override this built-in default."
      };
  const models = catalog?.supported === false ? [] : (catalog?.models ?? []);
  const search = query.trim().toLocaleLowerCase();
  const matches = models.filter((model) =>
    `${model.label ?? ""} ${model.id}`.toLocaleLowerCase().includes(search)
  );
  const visible = matches.filter(
    (model, index) => search || expanded || index < 4 || model.id === configured
  );
  const effective = models.find((model) =>
    configured ? model.id === configured : model.default || model.isDefault
  );
  const defaultLevel = effective?.thinking?.default_level;
  const known = models.some((model) => model.id === configured);
  const unavailable =
    catalog?.unavailableModels?.filter((model) =>
      `${model.label ?? ""} ${model.id}`.toLocaleLowerCase().includes(search)
    ) ?? [];

  const handleShortcut = usePersistCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        !(apple ? event.metaKey : event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      const key = Number(/^Digit([1-4])$/.exec(event.code)?.[1]);
      if (!activateModelPickerShortcut(key)) return;
      event.preventDefault();
      event.stopPropagation();
    }
  );
  const handleSearch = usePersistCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)
  );
  const handleModel = usePersistCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      void onModelChange(event.target.value)
  );
  const handleEffort = usePersistCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      void onEffortChange(event.target.value)
  );
  const toggleExpanded = usePersistCallback(() => setExpanded(!expanded));
  const reload = usePersistCallback(() => void onReload(true));
  return (
    <div
      className="multica-model-panel"
      data-model-picker-shortcuts
      onKeyDownCapture={handleShortcut}
    >
      <div className="multica-model-panel-columns">
        <section className="multica-model-column" aria-label={labels.model}>
          <label className="multica-model-search">
            <Search aria-hidden="true" className="size-4" />
            <input
              type="search"
              aria-label={copy.search}
              placeholder={copy.search}
              value={query}
              onChange={handleSearch}
            />
          </label>
          <div
            className="multica-model-options"
            role="radiogroup"
            aria-label={labels.model}
            aria-busy={loading || undefined}
          >
            <label
              className="multica-model-choice"
              data-selected={selected === null}
            >
              <input
                type="radio"
                name={`${id}-model`}
                checked={selected === null}
                disabled={disabled}
                value=""
                onChange={handleModel}
              />
              <span className="multica-model-name" title={defaultModel}>
                {labels.default}
                {defaultModel ? ` · ${defaultModel}` : ""}
              </span>
              {selected === null && (
                <Check aria-hidden="true" className="size-4" />
              )}
            </label>
            {visible.map((model, index) => (
              <div
                className="multica-model-option"
                key={model.id}
                data-selected={selected === model.id}
              >
                <label className="multica-model-choice">
                  <input
                    type="radio"
                    name={`${id}-model`}
                    aria-label={model.label || model.id}
                    checked={selected === model.id}
                    disabled={disabled}
                    value={model.id}
                    onChange={handleModel}
                    aria-keyshortcuts={
                      index < 4
                        ? `${apple ? "Meta" : "Control"}+${index + 1}`
                        : undefined
                    }
                    data-model-shortcut={index < 4 ? index + 1 : undefined}
                  />
                  <Bot aria-hidden="true" className="size-4" />
                  <span
                    className="multica-model-name"
                    title={`${model.label || model.id} (${model.id})`}
                  >
                    {model.label || model.id}
                  </span>
                  {selected === model.id && (
                    <Check aria-hidden="true" className="size-4" />
                  )}
                </label>
                {index < 4 && (
                  <kbd className="multica-model-shortcut" aria-hidden="true">
                    {apple ? <Command className="size-3" /> : "Ctrl"}
                    {index + 1}
                  </kbd>
                )}
              </div>
            ))}
            {configured && catalog && !known && (
              <p className="multica-model-message">
                {configured} · {labels.unknown}
              </p>
            )}
            {unavailable.map((model) => (
              <p
                className="multica-model-message"
                key={model.id}
                title={model.reason}
              >
                {model.label || model.id}
                {model.reason ? ` · ${model.reason}` : ""}
              </p>
            ))}
            {loading && (
              <p className="multica-model-message" role="status">
                {labels.loading}
              </p>
            )}
            {catalog?.supported === false && (
              <p className="multica-model-message">{labels.unsupported}</p>
            )}
            {catalog?.supported && models.length === 0 && (
              <p className="multica-model-message">{labels.empty}</p>
            )}
            {search && models.length > 0 && matches.length === 0 && (
              <p className="multica-model-message" role="status">
                {copy.noMatches}
              </p>
            )}
            {!search && (expanded || visible.length < models.length) && (
              <Button
                variant="ghost"
                size="sm"
                className="multica-model-show-more"
                onClick={toggleExpanded}
              >
                {expanded ? copy.less : copy.more}
              </Button>
            )}
          </div>
        </section>
        <section
          className="multica-reasoning-column"
          aria-labelledby={`${id}-reasoning`}
        >
          <div
            className="multica-model-reasoning-heading"
            tabIndex={-1}
            id={`${id}-reasoning`}
          >
            <span>{copy.reasoning}</span>
            <span className="multica-model-name" title={modelLabel}>
              {modelLabel}
            </span>
          </div>
          <div
            className="multica-model-options"
            role="radiogroup"
            aria-label={copy.reasoning}
            aria-busy={disabled || undefined}
          >
            {levels.length > 0 && (
              <label
                className="multica-model-choice"
                data-selected={selectedEffort === null}
              >
                <input
                  type="radio"
                  name={`${id}-effort`}
                  checked={selectedEffort === null}
                  disabled={disabled}
                  value=""
                  onChange={handleEffort}
                />
                <span className="multica-model-name">
                  {remote ? labels.default : copy.inherit}
                </span>
                {selectedEffort === null && (
                  <Check aria-hidden="true" className="size-4" />
                )}
              </label>
            )}
            {levels.map((level) => (
              <label
                className="multica-model-choice"
                key={level.value}
                data-selected={selectedEffort === level.value}
                title={level.description}
              >
                <input
                  type="radio"
                  name={`${id}-effort`}
                  aria-label={effortLabel(level.value, level.label)}
                  checked={selectedEffort === level.value}
                  disabled={disabled}
                  value={level.value}
                  onChange={handleEffort}
                />
                <span className="multica-model-name">
                  {effortLabel(level.value, level.label)}
                </span>
                {defaultLevel === level.value && (
                  <span
                    className="multica-model-default"
                    title={copy.builtInHelp}
                  >
                    {copy.builtIn}
                  </span>
                )}
                {selectedEffort === level.value && (
                  <Check aria-hidden="true" className="size-4" />
                )}
              </label>
            ))}
            {!loading && catalog && levels.length === 0 && (
              <p className="multica-model-message">{noReasoningOptions}</p>
            )}
          </div>
        </section>
      </div>
      {(error || remote) && (
        <div className="multica-model-panel-footer">
          {error && (
            <p role="alert" className="multica-model-error">
              {error}
            </p>
          )}
          {(error || remote) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={loading || disabled}
              onClick={reload}
            >
              {error ? labels.retry : labels.refresh}
            </Button>
          )}
          {remote && (
            <p className="multica-model-message">{labels.modelScope}</p>
          )}
        </div>
      )}
    </div>
  );
}
