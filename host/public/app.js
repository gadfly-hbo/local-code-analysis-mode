/* Xanthil 本地分析工作台 — 原生 ES 模块，无构建链（W2）。
 * UI 只是操作入口：一切模型调用都发生在服务端经适配层/唯一网关（KA-M5-1）。 */
const $ = (id) => document.getElementById(id);

let pendingFile = null;
const approvedAliases = new Set();
let columnOptions = [];

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

/* ---------- 状态条与刷新 ---------- */
async function refreshState() {
  try {
    const s = await api("GET", "/api/state");
    $("model-badge").textContent = `模型：${s.model}`;
    $("sandbox-badge").textContent = `沙箱：${s.sandbox}`;
    const skillSel = $("skill-select");
    skillSel.innerHTML = "";
    skillSel.append(el("option", { value: "" }, "内置技能（零模型调用）…"));
    for (const skill of s.skills) {
      skillSel.append(
        el(
          "option",
          { value: skill.name },
          `${skill.name} — ${skill.description}`,
        ),
      );
    }
    renderDatasets(s.datasets);
    renderTasks(s.tasks);
    renderPublications(s.publications);
  } catch (error) {
    console.error(error);
  }
}

/* ---------- 数据区 ---------- */
function renderDatasets(datasets) {
  const list = $("dataset-list");
  list.innerHTML = "";
  for (const d of datasets) {
    const hasCard = Boolean(d.schema_version);
    const row = el(
      "div",
      { class: "card" },
      el(
        "div",
        { class: "head" },
        el("span", { class: "grow" }, `${d.uri}`),
        hasCard
          ? el("span", { class: "status succeeded" }, "口径已确认")
          : el("span", { class: "status awaiting_confirmation" }, "待确认口径"),
      ),
      el(
        "div",
        { class: "note" },
        `版本 ${d.current_version.slice(0, 10)}… · ${d.versions} 个版本`,
      ),
    );
    if (hasCard) approvedAliases.add(d.alias);
    list.append(row);
  }
}

const dropZone = $("drop-zone");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () =>
  dropZone.classList.remove("dragover"),
);
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files.length) acceptFile(e.dataTransfer.files[0]);
});
$("file-input").addEventListener("change", (e) => {
  if (e.target.files.length) acceptFile(e.target.files[0]);
});

function acceptFile(file) {
  pendingFile = file;
  $("upload-error").classList.add("hidden");
  $("alias-row").classList.remove("hidden");
  const suggested =
    file.name
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/^[^a-z]+/, "") || "data";
  $("alias-input").value = suggested;
}

$("upload-btn").addEventListener("click", async () => {
  if (!pendingFile) return;
  const alias = $("alias-input").value.trim();
  if (!alias) return showUploadError("请填写别名");
  const b64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(pendingFile);
  });
  try {
    const out = await api("POST", "/api/datasets", {
      alias,
      filename: pendingFile.name,
      contentB64: b64,
    });
    openSchemaEditor(alias, out.profile);
    refreshState();
  } catch (error) {
    showUploadError(error.message);
  }
});

function showUploadError(message) {
  const box = $("upload-error");
  box.textContent = message;
  box.classList.remove("hidden");
}

function openSchemaEditor(alias, profile) {
  const editor = $("schema-editor");
  editor.classList.remove("hidden");
  editor.dataset.alias = alias;
  $("grain-input").value = "";
  if (profile.sheet_names?.length > 1) {
    $("sheet-note").textContent =
      profile.sheet_note ??
      `多工作表：${profile.sheet_names.join(", ")}（仅分析第一张）`;
    $("sheet-note").classList.remove("hidden");
  } else {
    $("sheet-note").classList.add("hidden");
  }
  const tbody = $("columns-table").querySelector("tbody");
  const thead = $("columns-table").querySelector("thead");
  tbody.innerHTML = "";
  thead.innerHTML = "";
  thead.append(
    el(
      "tr",
      {},
      el("th", {}, "字段"),
      el("th", {}, "类型"),
      el("th", {}, "业务含义（给模型看的口径）"),
    ),
  );
  columnOptions = [];
  for (const col of profile.columns) {
    const semanticsInput = el("input", {
      value: col.leading_zero_candidate ? "前导零保留" : "",
    });
    const typeSelect = el("select", {});
    for (const t of ["string", "integer", "number", "date", "boolean"]) {
      const inferred = col.leading_zero_candidate
        ? "string"
        : col.inferred_type;
      typeSelect.append(
        el(
          "option",
          { value: t, ...(t === inferred ? { selected: "" } : {}) },
          t,
        ),
      );
    }
    tbody.append(
      el(
        "tr",
        {},
        el("td", {}, col.name),
        el("td", {}, typeSelect),
        el("td", {}, semanticsInput),
      ),
    );
    columnOptions.push(col.name);
  }
}

$("approve-schema-btn").addEventListener("click", async () => {
  const alias = $("schema-editor").dataset.alias;
  const columns = {};
  $("columns-table")
    .querySelectorAll("tbody tr")
    .forEach((tr) => {
      const name = tr.children[0].textContent;
      const type = tr.querySelector("select").value;
      const semantics = tr.querySelector("input").value || "";
      columns[name] = { type, semantics };
    });
  const dateFields = [];
  const amountFields = [];
  $("columns-table").querySelectorAll("tbody tr").forEach((tr) => {
    const name = tr.children[0].textContent;
    const semantics = tr.querySelector("input").value || "";
    if (/日期|date/i.test(semantics) || /date/i.test(name)) dateFields.push(name);
    if (/金额|amount|金额口径|净额/i.test(semantics) || /amount|net/i.test(name)) amountFields.push(name);
  });
  const card = {
    dataset: alias,
    grain: $("grain-input").value.trim(),
    columns,
    unique_keys: [],
    notes: [],
    checks: { date_fields: dateFields, amount_fields: amountFields, precision: 2 },
  };
  try {
    await api("POST", "/api/schema", { alias, card });
    $("schema-editor").classList.add("hidden");
    refreshState();
  } catch (error) {
    showUploadError(error.message);
  }
});

/* ---------- 分析区 ---------- */
$("ask-btn").addEventListener("click", async () => {
  const goal = $("goal-input").value.trim();
  if (!goal || approvedAliases.size === 0) return;
  try {
    await api("POST", "/api/ask", { goal, datasets: [...approvedAliases] });
    $("goal-input").value = "";
    refreshState();
  } catch (error) {
    alert(error.message);
  }
});

$("skill-run-btn").addEventListener("click", async () => {
  const skill = $("skill-select").value;
  if (!skill || approvedAliases.size === 0) return;
  const alias = [...approvedAliases][0];
  try {
    const params =
      skill === "monthly_compare"
        ? {
            dataset: alias,
            date_field: pickColumn(/date|日期/),
            value_field: pickColumn(/amount|金额|net/),
            order_field: pickColumn(/order|订单/),
          }
        : {
            dataset: alias,
            category_field: pickColumn(/category|品类|类/),
            value_field: pickColumn(/amount|金额|net/),
          };
    await api("POST", "/api/skill-run", { skill, dataset: alias, params });
    refreshState();
  } catch (error) {
    alert(error.message);
  }
});

function pickColumn(hint) {
  const hit = columnOptions.find((c) => hint.test(c));
  return hit ?? columnOptions[0];
}

function renderTasks(tasks) {
  const list = $("task-list");
  list.innerHTML = "";
  for (const t of [...tasks].reverse()) {
    const card = el(
      "div",
      { class: "card", "data-id": t.id },
      el(
        "div",
        { class: "head" },
        el("span", { class: "status " + t.status }, statusLabel(t.status)),
        el("span", { class: "grow" }, t.goal),
      ),
    );
    if (t.status === "awaiting_confirmation") {
      card.append(
        el(
          "div",
          { class: "row" },
          el(
            "button",
            { class: "primary small", onclick: () => confirmTask(t.id, card) },
            "确认并运行",
          ),
          el(
            "button",
            { class: "small", onclick: () => cancelTask(t.id) },
            "取消",
          ),
        ),
      );
    }
    list.append(card);
    if (t.status === "awaiting_confirmation") void loadTaskDetail(t.id, card);
    if (t.status === "succeeded") void loadTaskArtifacts(t.id, card);
  }
}

async function loadTaskArtifacts(id, card) {
  try {
    const artifacts = await api("GET", `/api/tasks/${id}/artifacts`);
    for (const artifact of artifacts) {
      if (artifact.type === "chart") {
        card.append(el("img", { class: "chart", src: `/api/artifacts/${artifact.id}/raw` }));
      } else {
        const raw = await api("GET", `/api/artifacts/${artifact.id}/raw`);
        card.append(renderCsvTable(raw.text), el("div", { class: "row" },
          el("button", { class: "small", onclick: () => exportArtifact(artifact.id) }, `导出 ${artifact.name}`)));
      }
    }
  } catch { /* 非关键 */ }
}

function statusLabel(status) {
  return (
    {
      awaiting_confirmation: "待确认",
      ready: "已确认",
      running: "运行中",
      succeeded: "成功",
      failed: "失败",
      cancelled: "已取消",
    }[status] ?? status
  );
}

async function loadTaskDetail(id, card) {
  try {
    const detail = await api("GET", `/api/tasks/${id}`);
    if (detail.spec) {
      card.append(
        detail.spec.assumptions.length
          ? el(
              "div",
              { class: "note" },
              `假设：${detail.spec.assumptions.join("；")}`,
            )
          : null,
        el("pre", { class: "code" }, detail.spec.code),
      );
    }
  } catch {
    /* 详情非关键 */
  }
}

async function confirmTask(id, card) {
  const btn = card.querySelector("button");
  if (btn) btn.disabled = true;
  try {
    await api("POST", `/api/tasks/${id}/confirm`);
    const run = await api("POST", `/api/tasks/${id}/run`);
    showRunResult(run);
    refreshState();
  } catch (error) {
    alert(error.message);
    refreshState();
  }
}

async function cancelTask(id) {
  try {
    await api("POST", `/api/tasks/${id}/cancel`);
    refreshState();
  } catch (error) {
    alert(error.message);
  }
}

async function showRunResult(run) {
  const card = document.querySelector(`[data-id="${run.id}"]`);
  for (const artifact of run.artifacts ?? []) {
    if (artifact.type === "chart") {
      card.append(
        el("img", { class: "chart", src: `/api/artifacts/${artifact.id}/raw` }),
      );
    } else {
      const raw = await api("GET", `/api/artifacts/${artifact.id}/raw`);
      card.append(
        renderCsvTable(raw.text),
        el(
          "div",
          { class: "row" },
          el(
            "button",
            { class: "small", onclick: () => exportArtifact(artifact.id) },
            `导出 ${artifact.name}`,
          ),
        ),
      );
    }
  }
  if (run.error_summary)
    card.append(el("div", { class: "note" }, `原因：${run.error_summary}`));
}

function renderCsvTable(text) {
  const rows = text
    .trim()
    .split("\n")
    .map((line) => line.split(","));
  const table = el("table", { class: "data" });
  const head = el("tr", {}, ...rows[0].map((h) => el("th", {}, h)));
  table.append(el("thead", {}, head));
  const body = el("tbody");
  for (const row of rows.slice(1))
    body.append(el("tr", {}, ...row.map((c) => el("td", {}, c))));
  table.append(body);
  return table;
}

async function exportArtifact(id) {
  const out = prompt("导出到路径：", `${id}.csv`);
  if (!out) return;
  try {
    await api("POST", `/api/artifacts/${id}/export`, { outPath: out });
    alert(`已导出：${out}`);
  } catch (error) {
    alert(error.message);
  }
}

/* ---------- 发布区 ---------- */
$("publish-new-btn").addEventListener("click", () => {
  const form = $("publish-form");
  form.classList.remove("hidden");
  form.innerHTML = "";
  if (approvedAliases.size === 0) {
    form.append(
      el("div", { class: "note" }, "请先登记并确认至少一个数据集的口径。"),
    );
    return;
  }
  const alias = [...approvedAliases][0];
  const subject = el(
    "select",
    {},
    ...columnOptions.map((c) => el("option", { value: c }, c)),
  );
  const dims = el(
    "div",
    {},
    ...columnOptions.map((c) =>
      el(
        "label",
        { class: "note" },
        el("input", { type: "checkbox", value: c }),
        ` ${c}`,
      ),
    ),
  );
  const metricsBox = el("div");
  const addMetric = () =>
    metricsBox.append(
      el(
        "div",
        { class: "row" },
        el("input", { class: "m-name", placeholder: "指标名" }),
        el(
          "select",
          { class: "m-agg" },
          ...[
            "sum",
            "count",
            "count_distinct",
            "avg",
            "mean",
            "median",
            "std",
            "ratio",
          ].map((a) => el("option", { value: a }, a)),
        ),
        el("input", {
          class: "m-field",
          placeholder: "字段（ratio 用 逗号分隔分子/分母）",
        }),
      ),
    );
  addMetric();
  const purpose = el("input", { value: "解读分析结果" });
  const target = el("input", { value: "fixture" });
  const minSubjects = el("input", { type: "number", value: "2" });
  form.append(
    el("h3", {}, `数据集 ${alias}`),
    el("div", { class: "row" }, el("span", { class: "note" }, "目的"), purpose),
    el(
      "div",
      { class: "row" },
      el("span", { class: "note" }, "目标模型"),
      target,
    ),
    el(
      "div",
      { class: "row" },
      el("span", { class: "note" }, "主体字段"),
      subject,
      el("span", { class: "note" }, "最小主体数"),
      minSubjects,
    ),
    el("h3", {}, "维度（勾选）"),
    dims,
    el("h3", {}, "指标"),
    metricsBox,
    el(
      "div",
      { class: "row" },
      el("button", { class: "small", onclick: addMetric }, "+ 指标"),
      el(
        "button",
        {
          class: "primary",
          onclick: () =>
            submitPlan(
              alias,
              form,
              purpose,
              target,
              subject,
              minSubjects,
              dims,
              metricsBox,
            ),
        },
        "计算预览",
      ),
    ),
  );
});

async function submitPlan(
  alias,
  form,
  purpose,
  target,
  subject,
  minSubjects,
  dims,
  metricsBox,
) {
  const metrics = [...metricsBox.querySelectorAll(".row")].map((row) => {
    const agg = row.querySelector(".m-agg").value;
    const fieldRaw = row.querySelector(".m-field").value.trim();
    const metric = {
      name: row.querySelector(".m-name").value.trim() || "m",
      agg,
      field: fieldRaw,
    };
    if (agg === "ratio" && fieldRaw.includes(",")) {
      const [num, den] = fieldRaw.split(",").map((s) => s.trim());
      delete metric.field;
      metric.numerator = num;
      metric.denominator = den;
    }
    return metric;
  });
  const dimensions = [...dims.querySelectorAll("input:checked")].map(
    (c) => c.value,
  );
  const plan = {
    dataset: alias,
    purpose: purpose.value,
    target_model: target.value,
    subject_field: subject.value,
    min_subjects: Number(minSubjects.value),
    max_sends: 3,
    expires_hours: 24,
    precision: 2,
    metrics,
    dimensions,
    filters: [],
  };
  // plan 对象走服务端 J8 入口: 先落 YAML 再 prepare
  try {
    const pub = await api("POST", "/api/publications/object", { plan });
    form.classList.add("hidden");
    showPublication(pub);
    refreshState();
  } catch (error) {
    alert(error.message);
  }
}

function renderPublications(publications) {
  const list = $("publication-list");
  list.innerHTML = "";
  for (const p of publications) {
    const card = el(
      "div",
      { class: "card", "data-pub": p.id },
      el(
        "div",
        { class: "head" },
        el("span", { class: "status " + p.status }, p.status),
        el("span", { class: "grow" }, p.purpose),
      ),
    );
    if (p.block_reason)
      card.append(el("div", { class: "note" }, `阻断：${p.block_reason}`));
    list.append(card);
    if (p.status === "prepared" || p.status === "awaiting_approval")
      void loadPublicationDetail(p, card);
  }
}

async function loadPublicationDetail(p, card) {
  try {
    const detail = await api("GET", `/api/publications/${p.id}`);
    if (!detail.payload) return;
    for (const metric of detail.payload.metrics ?? []) {
      card.append(el("h3", {}, metric.name));
      const table = el("table", { class: "data" });
      table.append(
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ...Object.keys(metric.rows[0]?.dimensions ?? { 组: "" }).map((k) =>
              el("th", {}, k),
            ),
            el("th", {}, "值"),
          ),
        ),
      );
      const body = el("tbody");
      for (const row of metric.rows) {
        body.append(
          el(
            "tr",
            {},
            ...Object.values(row.dimensions).map((v) => el("td", {}, v)),
            el("td", {}, String(row.value)),
          ),
        );
      }
      table.append(body);
      card.append(table);
    }
    card.append(
      el(
        "div",
        { class: "note" },
        `被压制分组：${detail.payload.suppressed_group_count} · 主体下限 ${detail.payload.min_subjects}`,
      ),
    );
    const actions = el("div", { class: "row" });
    if (p.status === "prepared") {
      actions.append(
        el(
          "button",
          { class: "primary small", onclick: () => approvePublication(p.id) },
          "授权并解读",
        ),
      );
    }
    if (p.status === "awaiting_approval" || p.status === "sent") {
      actions.append(
        el(
          "button",
          { class: "small", onclick: () => sendPublication(p.id, card) },
          "发送给模型",
        ),
      );
    }
    actions.append(
      el(
        "button",
        { class: "small", onclick: () => revokePublication(p.id) },
        "撤销",
      ),
    );
    card.append(actions);
  } catch {
    /* 非关键 */
  }
}

function showPublication(pub) {
  refreshState();
  if (pub.status === "blocked") alert(`发布被阻断：\n${pub.block_reason}`);
}

async function approvePublication(id) {
  try {
    const approval = await api("POST", `/api/publications/${id}/approve`);
    if (
      !confirm(
        `授权发送这些聚合结果？\n目标模型：${approval.target_model}\n次数上限：${approval.max_sends}\n到期：${approval.expires_at}\n\n不发送原始记录。聚合指标仍属于您的业务信息。`,
      )
    ) {
      await api("POST", `/api/publications/${id}/revoke`);
      refreshState();
      return;
    }
    await sendPublication(id, null);
  } catch (error) {
    alert(error.message);
    refreshState();
  }
}

async function sendPublication(id, card) {
  try {
    const out = await api("POST", `/api/publications/${id}/send`);
    if (out.status === "sent" && out.reply) {
      openModal(
        el(
          "div",
          {},
          el("h3", {}, "模型解读（仅基于已发布的聚合证据）"),
          el("pre", { class: "reply" }, out.reply),
        ),
      );
    } else if (out.block_reason) {
      alert(`未发送：${out.block_reason}`);
    }
    refreshState();
  } catch (error) {
    alert(error.message);
    refreshState();
  }
}

async function revokePublication(id) {
  try {
    await api("POST", `/api/publications/${id}/revoke`);
    refreshState();
  } catch (error) {
    alert(error.message);
  }
}

/* ---------- 审计 ---------- */
$("audit-btn").addEventListener("click", async () => {
  try {
    const calls = await api("GET", "/api/audit");
    const table = el("table", { class: "data" });
    table.append(
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "时间"),
          el("th", {}, "提供方"),
          el("th", {}, "用途"),
          el("th", {}, "结果"),
        ),
      ),
    );
    const body = el("tbody");
    for (const c of [...calls].reverse()) {
      body.append(
        el(
          "tr",
          {},
          el("td", {}, c.at),
          el("td", {}, c.provider),
          el("td", {}, c.purpose),
          el("td", {}, c.outcome),
        ),
      );
    }
    table.append(body);
    openModal(
      el(
        "div",
        {},
        el("h3", {}, "模型出站记录（全部经唯一网关）"),
        table,
        el("div", { class: "note" }, "完整载荷见工作区 .xanthil/logs/egress/"),
      ),
    );
  } catch (error) {
    alert(error.message);
  }
});

function openModal(content) {
  $("modal-card").innerHTML = "";
  $("modal-card").append(
    content,
    el(
      "div",
      { class: "row" },
      el("button", { class: "primary", onclick: closeModal }, "关闭"),
    ),
  );
  $("modal").classList.remove("hidden");
}
function closeModal() {
  $("modal").classList.add("hidden");
}
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) closeModal();
});

refreshState();
setInterval(refreshState, 5000);
