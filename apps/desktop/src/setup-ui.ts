// The setup window: getting the machine ready (Docker and an agent, with a
// little terminal for installs and sign-ins), then starting the server.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { NibbletSetupApi, SetupStep, ToolsUpdate } from "./preload.ts";
import type { ToolReport } from "./tools.ts";

declare global {
  interface Window {
    nibbletSetup: NibbletSetupApi;
  }
}

const setup = window.nibbletSetup;

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from setup.html`);
  return found;
}
function button(id: string): HTMLButtonElement {
  const found = el(id);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`#${id} isn't a button`);
  return found;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string } = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  node.append(...children);
  return node;
}

// Pages

setup.onPage((page) => {
  el("page-tools").hidden = page !== "tools";
  el("page-progress").hidden = page !== "progress";
  if (page === "tools") fit();
});

// Getting ready

let running = false;
let lastUpdate: ToolsUpdate | null = null;

function toolRow(report: ToolReport): HTMLElement {
  const { state } = report;
  const status = state.ready ? "ready" : state.installed ? "installed" : "missing";
  const actions = h("div", { className: "actions" });
  for (const action of report.actions) {
    const b = h("button", { text: action.label, className: action.primary ? "primary" : "" });
    b.disabled = running && action.kind === "run";
    b.addEventListener("click", () => setup.runAction(report.id, action.id));
    actions.append(b);
  }
  return h(
    "div",
    { className: `tool ${status}` },
    h("span", { className: "dot" }),
    h(
      "div",
      {},
      h("div", { className: "name", text: report.name }),
      h("div", { className: "detail", text: report.blurb }),
      h("div", { className: "state", text: state.ready ? `✓ ${state.detail}` : state.detail }),
    ),
    actions,
  );
}

function renderTools(update: ToolsUpdate): void {
  lastUpdate = update;
  el("engines").replaceChildren(...update.reports.filter((r) => r.kind === "engine").map(toolRow));
  el("agents").replaceChildren(...update.reports.filter((r) => r.kind === "agent").map(toolRow));
  const go = button("continue");
  go.disabled = !update.ready || running;
  const docker = update.reports.find((r) => r.kind === "engine");
  const agents = update.reports.filter((r) => r.kind === "agent" && r.state.ready);
  el("hint").textContent = update.ready
    ? `Ready, with ${agents.map((a) => a.name).join(", ")}.`
    : docker && !docker.state.ready
      ? "Waiting for Docker to be running."
      : "Waiting for you to sign in to an agent.";
}

setup.onTools(renderTools);
button("continue").addEventListener("click", () => setup.continueSetup());

// The little terminal

const term = new Terminal({
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 11,
  convertEol: false,
  cursorBlink: true,
  scrollback: 2000,
  theme: matchMedia("(prefers-color-scheme: dark)").matches
    ? { background: "#141414", foreground: "#d8d8d8" }
    : { background: "#e8e8e8", foreground: "#1c1c1c", cursor: "#1c1c1c" },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
let opened = false;

function fit(): void {
  if (el("terminal").hidden) return;
  if (!opened) {
    term.open(el("term"));
    opened = true;
  }
  fitAddon.fit();
  setup.termResize(term.cols, term.rows);
}

function showTerminal(title: string): void {
  el("terminal").hidden = false;
  el("term-title").textContent = title;
  fit();
  term.focus();
}

term.onData((data) => setup.termInput(data));
window.addEventListener("resize", fit);

setup.onTermData((chunk) => {
  if (!running) {
    running = true;
    el("link").hidden = true;
    button("term-stop").hidden = false;
    showTerminal("Running…");
    if (lastUpdate) renderTools(lastUpdate);
  }
  term.write(chunk);
});

setup.onTermExit((code) => {
  running = false;
  button("term-stop").hidden = true;
  el("term-title").textContent = code === 0 ? "Done" : `Stopped (exit code ${code})`;
  term.write(`\r\n\x1b[2m${code === 0 ? "Done." : "That didn't finish."}\x1b[0m\r\n`);
  setup.refreshTools();
});

let linkUrl = "";
setup.onUrl((url) => {
  linkUrl = url;
  el("link-url").textContent = url;
  el("link-url").title = url;
  el("link").hidden = false;
});
button("link-open").addEventListener("click", () => setup.openUrl(linkUrl));
button("link-copy").addEventListener("click", () => {
  setup.copyUrl(linkUrl);
  const b = button("link-copy");
  b.textContent = "Copied";
  setTimeout(() => (b.textContent = "Copy link"), 1500);
});
button("term-stop").addEventListener("click", () => setup.stopCommand());
button("term-hide").addEventListener("click", () => {
  if (running) setup.stopCommand();
  el("terminal").hidden = true;
});

// Starting the server

const log = el("log");
const retry = button("retry");

setup.onStep((step: SetupStep) => {
  const li = el(step.id);
  li.className = step.state;
  const detail = li.querySelector(".detail");
  if (detail) detail.textContent = step.detail;
  if (step.state === "error") retry.hidden = false;
  if (step.state === "running") retry.hidden = true;
});

setup.onLog((line) => {
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
});

retry.addEventListener("click", () => {
  log.textContent = "";
  setup.retry();
});
