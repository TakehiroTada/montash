/**
 * Inspector の効果フォーム（docs/06 §2.5、計画 P3-2）。
 *
 * **入力欄は 1 つもハードコードしない。** `GET /api/specs` が返すエフェクトのパラメータ定義
 * （`EffectParamSpec`）から、number はスライダー／数値入力、choices 付き string はセレクト、
 * boolean はチェックボックスを組む。プラグインが増やした効果も、Web を触らずにここに出る。
 *
 * 値を変えたら **`POST /api/cli` で `effect set` を発行する**（docs/06 §1.1: Web の状態変更は
 * 必ずコマンド発行。project.json は直接書かない）。許可リストに `effect set` が無い、または
 * `--read-only` のときは入力を無効化し、**理由と手で打つコマンド**を見せる（docs/06 §3.3）。
 */
import type { KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { execCli } from "../cli-client.ts";
import {
  availableEffects,
  type EffectField,
  type EffectTarget,
  type EffectView,
  effectAddArgs,
  effectFields,
  effectRemoveArgs,
  effectSetArgs,
  effectViews,
  formatCommand,
  unknownParams,
} from "../lib/specs.ts";
import { type ClipLike, useStore } from "../store.ts";

function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" title={text} onClick={() => void navigator.clipboard?.writeText(text)}>
      copy
    </button>
  );
}

/** 1 つのパラメータ。編集中の値はローカルに持ち、確定（blur / Enter / スライダー離し）で発行する */
function ParamControl({
  id,
  field,
  disabled,
  onCommit,
}: {
  id: string;
  field: EffectField;
  disabled: boolean;
  onCommit(value: number | string | boolean): void;
}) {
  const [draft, setDraft] = useState<number | string | boolean>(field.value);
  // 外から値が変わったら（他の操作・checkout・WS 更新）編集中の値を捨てて追随する
  useEffect(() => setDraft(field.value), [field.value]);

  const commit = (value: number | string | boolean) => {
    if (value === field.value) return;
    onCommit(value);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit(draft);
    if (e.key === "Escape") setDraft(field.value);
  };

  switch (field.control) {
    case "checkbox":
      return (
        <input
          id={id}
          type="checkbox"
          checked={draft === true}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.checked);
            commit(e.target.checked);
          }}
        />
      );
    case "select":
      return (
        <select
          id={id}
          value={String(draft)}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
        >
          {field.choices?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      );
    case "slider":
      return (
        <span className="slider-row">
          <input
            id={id}
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={Number(draft)}
            disabled={disabled}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => commit(draft)}
            onKeyUp={(e) => {
              if (e.key.startsWith("Arrow")) commit(draft);
            }}
            onBlur={() => commit(draft)}
          />
          <input
            type="number"
            className="num"
            min={field.min}
            max={field.max}
            step={field.step}
            value={Number(draft)}
            disabled={disabled}
            onChange={(e) => setDraft(Number(e.target.value))}
            onBlur={() => commit(draft)}
            onKeyDown={onKey}
          />
        </span>
      );
    case "number":
      return (
        <input
          id={id}
          type="number"
          className="num"
          min={field.min}
          max={field.max}
          value={Number(draft)}
          disabled={disabled}
          onChange={(e) => setDraft(Number(e.target.value))}
          onBlur={() => commit(draft)}
          onKeyDown={onKey}
        />
      );
    default:
      return (
        <input
          id={id}
          type="text"
          value={String(draft)}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={onKey}
        />
      );
  }
}

function EffectCard({ clipId, view, disabled }: { clipId: string; view: EffectView; disabled: boolean }) {
  const extras = unknownParams(view.spec, view.params);
  return (
    <li className="effect-card">
      <div className="effect-head">
        <span className="id">{view.type}</span>
        {view.missing ? (
          <span className="badge err" title={`このプロジェクトには効果 "${view.type}" の定義がありません`}>
            プラグイン不足
          </span>
        ) : (
          <span className="badge">{view.spec?.source}</span>
        )}
        <span className="dim" style={{ flex: 1 }}>
          {view.spec?.summary ?? ""}
        </span>
        <CopyButton text={formatCommand(effectRemoveArgs(clipId, view.index))} />
      </div>

      {view.missing ? (
        <p className="hint-note">
          値はそのまま保持されます（レンダー時に <code>E_PLUGIN_MISSING</code>）。
          <code>montash plugin doctor</code> で不足を確認してください。
        </p>
      ) : null}

      {view.spec?.requires.length ? <p className="hint-note">requires: {view.spec.requires.join(", ")}</p> : null}

      {view.spec
        ? effectFields(view.spec, view.params).map((field) => {
            const id = `fx-${clipId}-${view.index}-${field.name}`;
            return (
              <label className="field effect-param" htmlFor={id} key={field.name}>
                <span>
                  {field.name}
                  {field.required ? " *" : ""}
                  {field.present ? "" : " (既定)"} — {field.describe}
                </span>
                <ParamControl
                  id={id}
                  field={field}
                  disabled={disabled}
                  onCommit={(value) => void execCli(effectSetArgs(clipId, view.index, field.name, value))}
                />
              </label>
            );
          })
        : null}

      {extras.length > 0 ? (
        <p className="hint-note">
          定義に無いパラメータ: {extras.map((k) => `${k}=${String(view.params[k])}`).join(" ")}
        </p>
      ) : null}
    </li>
  );
}

export interface EffectsPanelProps {
  clip: ClipLike;
  target: EffectTarget;
  /** `effect set` を実行できない理由（できるなら null）。docs/06 §3.3 */
  disabledReason: string | null;
}

export function EffectsPanel({ clip, target, disabledReason }: EffectsPanelProps) {
  const specs = useStore((s) => s.specs);
  const views = effectViews(specs, clip, target);
  const disabled = disabledReason !== null;
  const known = availableEffects(specs, target);

  return (
    <div className="effects">
      <h3>
        Effects ({views.length}
        {target === "audio" ? " · audio" : ""})
      </h3>
      {disabledReason ? <p className="err-note">{disabledReason}</p> : null}
      {views.length === 0 ? <p className="placeholder-note">効果は掛かっていません。</p> : null}
      <ul className="list effect-list">
        {views.map((view) => (
          <EffectCard key={`${view.index}:${view.type}`} clipId={clip.id} view={view} disabled={disabled} />
        ))}
      </ul>
      {known.length > 0 ? (
        <details className="effect-add">
          <summary>効果を足す（{known.length} 種）</summary>
          <ul className="list">
            {known.map((e) => (
              <li key={e.name}>
                <span className="id">{e.name}</span>
                <span className="dim" style={{ flex: 1 }}>
                  {e.summary}
                </span>
                <CopyButton text={formatCommand(effectAddArgs(clip.id, e.name))} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
