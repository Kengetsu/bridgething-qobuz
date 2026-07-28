import { settings } from "@bridgething/client/settings";
import React, { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Values = {
  bridgeUrl: string;
  brightnessMode: "auto" | "manual";
  brightnessLevel: number;
};

const defaults: Values = {
  bridgeUrl: "",
  brightnessMode: "auto",
  brightnessLevel: 0.55,
};

function parseBrightnessMode(v: string | undefined): Values["brightnessMode"] {
  return v === "manual" ? "manual" : "auto";
}

function parseBrightnessLevel(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0.05, Math.min(1, n)) : defaults.brightnessLevel;
}

function SettingsApp() {
  const [values, setValues] = useState<Values>(defaults);
  const [status, setStatus] = useState("Loading…");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [configEntries, docEntries] = await Promise.all([
          settings.config.list(),
          settings.doc.list(),
        ]);
        const cfg = Object.fromEntries(configEntries.map((e) => [e.key, e.value]));
        const doc = Object.fromEntries(docEntries.map((e) => [e.key, e.value]));
        if (!cancelled) {
          setValues({
            bridgeUrl: cfg.bridgeUrl ?? "",
            brightnessMode: parseBrightnessMode(doc.brightnessMode ?? cfg.brightnessMode),
            brightnessLevel: parseBrightnessLevel(doc.brightnessLevel ?? cfg.brightnessLevel),
          });
          setStatus("");
        }
      } catch (err) {
        if (!cancelled) setStatus(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((cur) => ({ ...cur, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const url = values.bridgeUrl.trim();
    if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      setStatus("URL must start with ws:// or wss://");
      return;
    }
    setStatus("Saving…");
    try {
      await settings.config.set("bridgeUrl", url);
      await settings.doc.set("brightnessMode", values.brightnessMode);
      await settings.doc.set("brightnessLevel", String(values.brightnessLevel));
      setStatus("Saved");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main>
      <h1>Qobuz</h1>
      <form onSubmit={save}>
        <label>
          Bridge URL
          <input
            value={values.bridgeUrl}
            onChange={(e) => set("bridgeUrl", e.target.value)}
            placeholder="ws://192.168.1.x:4173/ws"
            inputMode="url"
            spellCheck={false}
          />
        </label>

        <section>
          <h2>Display</h2>
          <label>
            Brightness mode
            <select
              value={values.brightnessMode}
              onChange={(e) => set("brightnessMode", e.target.value as Values["brightnessMode"])}
            >
              <option value="auto">Auto</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label>
            Brightness {Math.round(values.brightnessLevel * 100)}%
            <input
              type="range"
              min="5"
              max="100"
              value={Math.round(values.brightnessLevel * 100)}
              onChange={(e) => set("brightnessLevel", Number(e.target.value) / 100)}
            />
          </label>
        </section>

        <div className="actions">
          <button type="submit">Save</button>
          <button type="button" onClick={() => settings.done()}>Done</button>
        </div>
      </form>
      {status && <p>{status}</p>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
