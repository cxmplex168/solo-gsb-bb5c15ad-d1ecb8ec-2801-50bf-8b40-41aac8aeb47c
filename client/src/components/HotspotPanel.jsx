import { useEffect, useState } from "react";
import { analyzeHotspots } from "../api.js";

// Keep in sync with MAX_SAMPLES in server/hotspot.js.
const MAX_SAMPLES = 200;

export default function HotspotPanel({ schema }) {
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [openId, setOpenId] = useState(null);

  // Schema changed (re-inferred or validation target switched): the previous
  // hotspots no longer reflect the current contract, so drop them.
  useEffect(() => {
    setResult(null);
    setError(null);
    setOpenId(null);
  }, [schema]);

  async function runAnalysis() {
    setError(null);
    setResult(null);
    setOpenId(null);
    let samples;
    try {
      samples = JSON.parse(text);
      setParseError(null);
    } catch (e) {
      setParseError(e.message);
      return;
    }
    if (!Array.isArray(samples)) {
      setError('输入必须是 JSON 数组：每个元素为一条待检样本，例如 [{"id": 1}, {"id": 2}]。');
      return;
    }
    if (samples.length > MAX_SAMPLES) {
      setError(
        `单次最多分析 ${MAX_SAMPLES} 条样本，当前输入共 ${samples.length} 条，请分批分析。`
      );
      return;
    }
    setBusy(true);
    try {
      setResult(await analyzeHotspots(schema, samples));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(id) {
    setOpenId((prev) => (prev === id ? null : id));
  }

  return (
    <div className="hotspot-panel">
      <div className="scan-head">
        <span className="panel-label">错误热点</span>
        <span className="panel__meta">
          粘贴待检样本 JSON 数组，按当前校验目标逐条校验，并把 Ajv 错误按规则聚簇（单次最多{" "}
          {MAX_SAMPLES} 条）
        </span>
      </div>

      <textarea
        className={`code-input ${parseError ? "code-input--err" : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={6}
        placeholder='[{"id": 1, "tags": ["a", 1]}, {"id": "x", "extra": true}]'
      />
      {parseError && <div className="parse-error">JSON 解析失败：{parseError}</div>}

      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={runAnalysis}
          disabled={busy || text.trim() === ""}
        >
          {busy ? "分析中…" : "分析错误热点"}
        </button>
      </div>
      {error && <div className="alert alert--err">{error}</div>}

      {result && (
        <>
          <div className="scan-summary">
            <span className="hotspot-chip">样本 {result.total}</span>
            <span className="hotspot-chip hotspot-chip--ok">通过 {result.validSamples}</span>
            <span className="hotspot-chip hotspot-chip--err">未通过 {result.invalidSamples}</span>
            <span className="hotspot-chip hotspot-chip--err">错误 {result.errorCount}</span>
            <span className="hotspot-chip">簇 {result.clusterCount}</span>
            <span className="panel__meta">按受影响样本数降序 · 点击单簇展开详情</span>
          </div>

          {result.clusterCount === 0 && (
            <div className="alert alert--ok">✓ 全部样本均通过校验，没有错误热点。</div>
          )}

          <ul className="hotspot-list">
            {result.clusters.map((cluster, rank) => {
              const open = openId === cluster.id;
              return (
                <li key={cluster.id} className="hotspot-item">
                  <button
                    type="button"
                    className="hotspot-item__head"
                    onClick={() => toggle(cluster.id)}
                    aria-expanded={open}
                  >
                    <span className="hotspot-item__rank">#{rank + 1}</span>
                    <span className="flag flag--keyword">{cluster.keyword}</span>
                    {cluster.missingProperty !== undefined && (
                      <code className="hotspot-item__prop">{cluster.missingProperty}</code>
                    )}
                    {cluster.additionalProperty !== undefined && (
                      <code className="hotspot-item__prop">{cluster.additionalProperty}</code>
                    )}
                    <code className="hotspot-item__rule">{cluster.schemaPath}</code>
                    <span className="hotspot-chip hotspot-chip--err">
                      {cluster.affectedSamples} 个样本
                    </span>
                    <span className="hotspot-chip">{cluster.errorCount} 次</span>
                    <span className="scan-item__toggle">{open ? "▲" : "▼"}</span>
                  </button>
                  {open && (
                    <div className="hotspot-item__detail">
                      <div className="hotspot-detail__row">
                        <span className="hotspot-detail__label">受影响样本</span>
                        <span className="rel-samples">
                          {cluster.sampleIndexes.map((i) => (
                            <span key={i} className="hotspot-sample-chip">
                              #{i}
                            </span>
                          ))}
                        </span>
                      </div>
                      <div className="hotspot-detail__row">
                        <span className="hotspot-detail__label">实例 Pointer</span>
                        <ul className="hotspot-instances">
                          {cluster.instances.map((inst, i) => (
                            <li key={i}>
                              <code className="hotspot-instance__sample">#{inst.sampleIndex}</code>
                              <code className="hotspot-instance__pointer">{inst.pointer}</code>
                              <span className="hotspot-instance__msg">{inst.message}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      {cluster.instancesTruncated && (
                        <div className="panel__meta">
                          实例过多，仅展示前 {cluster.instances.length} 条。
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
