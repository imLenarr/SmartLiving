import { BrowserProvider, Contract, formatEther, getAddress, parseEther } from "ethers";
import { abi } from "./abi.js";

const $ = (id) => document.getElementById(id);
const wallet = window.ethereum;
const networkId = 11155111n;
const statuses = ["รอยืนยันหรือฝากเงิน", "กำลังเช่า", "รอผู้เช่าอนุมัติ", "อยู่ระหว่างพิจารณา", "ปิดสัญญาแล้ว", "ยกเลิกแล้ว"];
const formatter = new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });
const time = (seconds) => formatter.format(new Date(Number(seconds) * 1000));
const eth = (amount) => formatEther(amount) + " ETH";
const short = (address) => address.slice(0, 6) + "…" + address.slice(-4);
const formAddress = $("config").elements.address;
formAddress.value = localStorage.getItem("smartliving.address") || "";

let provider, contract, account, arbitrator, selection, blockTime;
let busy = false;
let walletChanged = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notice(message, error = false) {
  $("notice").className = error ? "error" : "";
  $("notice").textContent = message;
}

function errorMessage(error) {
  if (error.code === "ACTION_REJECTED" || error.code === 4001) return "ยกเลิกรายการใน MetaMask แล้ว";
  return error.reason || error.info?.error?.message || error.shortMessage || error.message;
}

function action(run) {
  return async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      await run(event);
    } catch (error) {
      notice(errorMessage(error), true);
    } finally {
      busy = false;
      if (walletChanged) {
        walletChanged = false;
        action(() => initialize(false))(event);
      }
    }
  };
}

function timestamp(value) {
  const result = Date.parse(value + ":00+07:00");
  if (!Number.isFinite(result)) throw new Error("กรุณาระบุวันและเวลา");
  return Math.floor(result / 1000);
}

function bangkokDateTime(seconds) {
  return new Date((Number(seconds) + 7 * 60 * 60) * 1000).toISOString().slice(0, 16);
}

function money(value) {
  const result = parseEther(value.trim());
  if (result < 0n) throw new Error("กรุณาระบุจำนวน ETH ตั้งแต่ 0 ขึ้นไป");
  return result;
}

async function send(method, ...args) {
  const sender = await contract.runner.getAddress();
  const [chain, accounts] = await Promise.all([
    wallet.request({ method: "eth_chainId" }),
    wallet.request({ method: "eth_accounts" })
  ]);
  if (BigInt(chain) !== networkId || accounts[0]?.toLowerCase() !== sender.toLowerCase()) {
    throw new Error("กรุณาตรวจสอบเครือข่ายและบัญชี แล้วเชื่อม MetaMask อีกครั้ง");
  }
  notice("ยืนยันธุรกรรมใน MetaMask");
  const tx = await contract[method](...args);
  notice("ส่งธุรกรรมแล้ว กำลังรอยืนยันบน Sepolia");
  await tx.wait();
  notice("ธุรกรรมสำเร็จ ");
  const link = node("a", "ดูบน Etherscan");
  link.href = "https://sepolia.etherscan.io/tx/" + tx.hash;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  $("notice").append(link);
  if (!walletChanged) {
    try {
      await refresh();
    } catch (error) {
      $("notice").append(node("p", "โหลดข้อมูลล่าสุดไม่ได้ · " + errorMessage(error)));
    }
  }
}

async function initialize(requestAccess) {
  contract = undefined;
  account = undefined;
  $("identity").textContent = "";
  $("dashboard").hidden = true;
  $("credit").textContent = "— ETH";
  $("withdraw").disabled = true;
  if (!wallet) throw new Error("กรุณาติดตั้ง MetaMask ในเบราว์เซอร์ก่อน");
  const accounts = await wallet.request({ method: requestAccess ? "eth_requestAccounts" : "eth_accounts" });
  if (!accounts.length) {
    notice("เชื่อม MetaMask เพื่อเริ่มใช้งาน");
    return;
  }
  account = getAddress(accounts[0]);
  $("identity").textContent = short(account);
  if (!formAddress.value.trim()) {
    notice("ใส่ Contract Address ที่ได้จาก Remix แล้วกดบันทึก");
    return;
  }
  provider = new BrowserProvider(wallet);
  if ((await provider.getNetwork()).chainId !== networkId) throw new Error("เลือกเครือข่าย Sepolia ใน MetaMask");
  const address = getAddress(formAddress.value.trim());
  if (await provider.getCode(address) === "0x") throw new Error("ไม่พบ Smart Contract ที่ที่อยู่นี้บน Sepolia");
  contract = new Contract(address, abi, await provider.getSigner(account));
  arbitrator = await contract.arbitrator();
  $("register").hidden = account === arbitrator;
  await refresh();
  $("dashboard").hidden = false;
  notice(account === arbitrator ? "เชื่อมต่อแล้ว · ผู้ชี้ขาด" : "เชื่อมต่อ Sepolia แล้ว");
}

async function rows(count, read, first = 1) {
  const result = [];
  for (let offset = 0; offset < Number(count); offset += 8) {
    const ids = Array.from({ length: Math.min(8, Number(count) - offset) }, (_, index) => first + offset + index);
    result.push(...await Promise.all(ids.map(async (id) => ({ id, data: await read(id) }))));
  }
  return result;
}

function button(text, run, className) {
  const element = node("button", text, className);
  element.type = "button";
  element.onclick = action(run);
  return element;
}

function showList(parent, items, label, type, empty) {
  parent.replaceChildren();
  for (const item of items) {
    parent.append(button(label(item), async () => {
      selection = { type, id: item.id };
      blockTime = (await provider.getBlock("latest")).timestamp;
      await showDetails();
    }, "entry"));
  }
  if (!items.length) parent.append(node("p", empty));
}

async function refresh() {
  const [propertyCount, agreementCount, credit, block] = await Promise.all([
    contract.propertyCount(), contract.agreementCount(), contract.credits(account), provider.getBlock("latest")
  ]);
  blockTime = block.timestamp;
  $("credit").textContent = eth(credit);
  $("withdraw").disabled = credit === 0n;
  const properties = await rows(propertyCount, (id) => contract.getProperty(id));
  const owned = properties.filter(({ data }) => data.owner === account);
  const ownedIds = new Set(owned.map(({ id }) => BigInt(id)));
  const agreements = (await rows(agreementCount, (id) => contract.getAgreement(id)))
    .filter(({ data }) => data.tenant === account || ownedIds.has(data.propertyId) || (account === arbitrator && [3, 4].includes(Number(data.status)) && data.disputeReason))
    .reverse();
  showList($("properties"), owned, ({ id, data }) => "#" + id + " · " + data.name, "property", "ยังไม่มีห้องในบัญชีนี้");
  showList($("agreements"), agreements, ({ id, data }) => "#" + id + " · " + statuses[Number(data.status)], "agreement", "ยังไม่มีสัญญาในบัญชีนี้");
  if (selection && !(selection.type === "property" ? owned : agreements).some(({ id }) => id === selection.id)) selection = undefined;
  await showDetails();
}

function facts(parent, entries) {
  const list = node("dl");
  for (const [label, value] of entries) list.append(node("dt", label), node("dd", value));
  parent.append(list);
}

function fields(parent, labels, submit, run) {
  const form = node("form", undefined, "fields");
  for (const [name, title, type, placeholder] of labels) {
    const label = node("label", title);
    const input = node(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    input.name = name;
    input.required = true;
    if (placeholder) input.placeholder = placeholder;
    if (name === "end" && type === "datetime-local") {
      input.min = bangkokDateTime(blockTime + 5 * 60);
      input.value = bangkokDateTime(blockTime + 60 * 60);
    }
    label.append(input);
    form.append(label);
  }
  form.append(node("button", submit));
  form.onsubmit = action(() => run(Object.fromEntries(new FormData(form))));
  parent.append(form);
}

async function showDetails() {
  const parent = $("detail");
  if (!selection) {
    parent.replaceChildren(node("p", "เลือกห้องหรือสัญญาเพื่อดูรายละเอียด"));
    return;
  }
  const { id, type } = selection;
  if (type === "property") {
    const p = await contract.getProperty(id);
    parent.replaceChildren(node("h2", p.name));
    facts(parent, [["เลขห้องในระบบ", id], ["ค่าเช่าต่องวด", eth(p.rent)], ["เงินประกัน", eth(p.deposit)]]);
    if (p.currentAgreement) {
      parent.append(button("เปิดสัญญา #" + p.currentAgreement, async () => {
        selection = { type: "agreement", id: Number(p.currentAgreement) };
        await showDetails();
      }));
    } else {
      parent.append(node("h3", "สร้างสัญญาเช่า"));
      fields(parent, [
        ["tenant", "Wallet ผู้เช่า", "text", "0x…"],
        ["start", "วันและเวลาเริ่มสัญญา (เวลาไทย)", "datetime-local"],
        ["end", "วันและเวลาสิ้นสุดสัญญา (เวลาไทย)", "datetime-local"],
        ["terms", "เงื่อนไขที่ตกลงกัน", "textarea", "เช่น กำหนดจ่ายค่าเช่าและเงื่อนไขการหักเงินประกัน"]
      ], "สร้างสัญญา", (d) => send("createAgreement", id, getAddress(d.tenant.trim()), timestamp(d.start), timestamp(d.end), d.terms.trim()));
    }
    return;
  }

  const [a, count] = await Promise.all([contract.getAgreement(id), contract.paymentCount(id)]);
  const p = await contract.getProperty(a.propertyId);
  const status = Number(a.status);
  const owner = account === p.owner;
  const tenant = account === a.tenant;
  const ended = blockTime >= Number(a.end);
  parent.replaceChildren(node("h2", "สัญญา #" + id + " · " + p.name));
  facts(parent, [
    ["สถานะ", statuses[status]], ["เจ้าของห้อง", p.owner], ["ผู้เช่า", a.tenant], ["ผู้ชี้ขาด", arbitrator],
    ["ระยะสัญญา", time(a.start) + " – " + time(a.end)], ["เงื่อนไข", a.terms],
    ["เจ้าของยืนยัน", a.ownerConfirmed ? "แล้ว" : "ยัง"], ["ผู้เช่ายืนยัน", a.tenantConfirmed ? "แล้ว" : "ยัง"],
    ["ค่าเช่าต่องวด", eth(p.rent)], ["เงินประกันตามสัญญา", eth(p.deposit)], ["เงินประกันที่พักไว้", eth(a.escrow)]
  ]);
  if (a.inspection) facts(parent, [["ผลตรวจห้อง", a.inspection]]);
  if (a.disputeReason) facts(parent, [["เหตุผลข้อพิพาท", a.disputeReason]]);
  if (a.decision) facts(parent, [["ผลการพิจารณา", a.decision], ["หักเงินประกัน", eth(a.deduction)], ["คืนผู้เช่า", eth(p.deposit - a.deduction)]]);
  else if (a.inspection) facts(parent, [["ยอดเสนอให้หัก", eth(a.deduction)], ["ยอดเสนอคืน", eth(a.escrow - a.deduction)]]);

  const actions = node("div", undefined, "actions");
  parent.append(actions);
  if (status === 0 && (owner || tenant)) {
    const confirmed = a.ownerConfirmed && a.tenantConfirmed;
    if (!ended && (owner ? !a.ownerConfirmed : !a.tenantConfirmed)) actions.append(button("ยืนยันสัญญา", () => send("confirmAgreement", id)));
    if (!ended && tenant && confirmed) actions.append(button("ฝาก " + eth(p.deposit), () => send("depositSecurity", id, { value: p.deposit })));
    if (!confirmed || ended) actions.append(button("ยกเลิกสัญญา", () => send("cancelAgreement", id)));
  }
  if (status === 1 && tenant && blockTime >= Number(a.start) && !ended) {
    actions.append(button("จ่ายค่าเช่า " + eth(p.rent), () => send("payRent", id, { value: p.rent })));
  }
  if (status === 2 && tenant) actions.append(button("อนุมัติคืน " + eth(a.escrow - a.deduction), () => send("approveRefund", id)));
  if (status === 1 && ended && owner) {
    parent.append(node("h3", "บันทึกผลตรวจห้อง"));
    fields(parent, [["deduction", "ยอดที่เสนอหัก (ETH)", "text", "0"], ["reason", "ผลตรวจและเหตุผล", "textarea"]],
      "ส่งให้ผู้เช่าอนุมัติ", (d) => send("submitInspection", id, money(d.deduction), d.reason.trim()));
  }
  if (ended && [1, 2].includes(status) && (owner || tenant)) {
    parent.append(node("h3", "เปิดข้อพิพาท"));
    fields(parent, [["reason", "เหตุผลที่ต้องการให้ผู้ชี้ขาดพิจารณา", "textarea"]],
      "ส่งข้อพิพาท", (d) => send("openDispute", id, d.reason.trim()));
  }
  if (status === 3 && account === arbitrator) {
    parent.append(node("h3", "ตัดสินข้อพิพาท"));
    fields(parent, [["deduction", "ยอดอนุมัติให้หัก (ETH)", "text", "0"], ["decision", "คำตัดสินและเหตุผล", "textarea"]],
      "บันทึกผลและจัดสรรเงิน", (d) => send("resolveDispute", id, money(d.deduction), d.decision.trim()));
  }
  parent.append(node("h3", "ประวัติชำระค่าเช่า"));
  if (!count) {
    parent.append(node("p", "ยังไม่มีรายการชำระ"));
    return;
  }
  const history = await rows(count, (index) => contract.getPayment(id, index), 0);
  const wrapper = node("div", undefined, "table-wrap");
  const table = node("table");
  const head = table.createTHead().insertRow();
  for (const label of ["งวด", "ยอดชำระ", "วันและเวลา (ไทย)"]) head.append(node("th", label));
  const body = table.createTBody();
  for (const { id: index, data } of history.reverse()) {
    const row = body.insertRow();
    for (const value of [index + 1, eth(data.amount), time(data.timestamp)]) row.append(node("td", value));
  }
  wrapper.append(table);
  parent.append(wrapper);
}

$("connect").onclick = action(() => initialize(true));
$("config").onsubmit = action(async () => {
  formAddress.value = getAddress(formAddress.value.trim());
  localStorage.setItem("smartliving.address", formAddress.value);
  selection = undefined;
  await initialize(false);
});
$("register-form").onsubmit = action(async (event) => {
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  await send("registerProperty", data.room.trim(), money(data.rent), money(data.deposit));
  form.reset();
  $("register").open = false;
});
$("withdraw").onclick = action(() => send("withdraw"));
$("refresh").onclick = action(async () => {
  await refresh();
  notice("อัปเดตข้อมูลล่าสุดแล้ว");
});

if (wallet) {
  const onWalletChange = () => {
    if (busy) walletChanged = true;
    else action(() => initialize(false))(new Event("change"));
  };
  wallet.on("accountsChanged", onWalletChange);
  wallet.on("chainChanged", onWalletChange);
  onWalletChange();
} else {
  notice("ติดตั้ง MetaMask แล้วเปิดหน้านี้ด้วยเบราว์เซอร์ที่เปิดส่วนขยาย");
}
