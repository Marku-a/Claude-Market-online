#!/usr/bin/env python3
"""Shopping-plan engine for a Hebrew supermarket assistant (stdlib only)."""
import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from datetime import date, datetime
from itertools import combinations

# Hebrew punctuation (maqaf, paseq, sof pasuq, nun hafukha) separates words
_HEB_PUNCT = re.compile("[\u05BE\u05C0\u05C3\u05C6]")
_NIQQUD = re.compile("[\u0591-\u05C7]")
_NOT_WORD = re.compile(r"[^\w%\s]|_", re.UNICODE)
_TRAIL_QTY = re.compile(r"^(.*?)\s*(?:(?<![A-Za-z])[xX]|[×*])\s*(\d+)\s*$")
_LEAD_QTY = re.compile(r"^(\d+)\s+(.+)$")


def normalize(text):
    text = _HEB_PUNCT.sub(" ", text or "")
    text = _NIQQUD.sub("", text)
    text = _NOT_WORD.sub(" ", text).lower()
    return " ".join(text.split())


def similarity(a, b):
    ta, tb = set(normalize(a).split()), set(normalize(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def parse_list_line(line):
    s = (line or "").strip()
    if not s or s.startswith("#"):
        return None
    qty, query = None, s
    m = _LEAD_QTY.match(s)
    if m and 1 <= int(m.group(1)) <= 99:
        qty, query = int(m.group(1)), m.group(2).strip()
    else:
        m = _TRAIL_QTY.match(s)
        if m and m.group(1).strip() and 1 <= int(m.group(2)) <= 99:
            qty, query = int(m.group(2)), m.group(1).strip()
    return {"raw": line, "query": query, "qty": qty}


# ---------------------------------------------------------------- loading

def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except OSError as e:
        raise ValueError("cannot read %s: %s" % (path, e))
    except ValueError as e:
        raise ValueError("invalid JSON in %s: %s" % (path, e))


def load_history(path):
    data = _load_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("orders"), list):
        raise ValueError("%s: expected object with 'orders' list" % path)
    for o in data["orders"]:
        if not isinstance(o, dict) or "date" not in o or not isinstance(o.get("items"), list):
            raise ValueError("%s: each order needs 'date' and 'items'" % path)
        try:
            date.fromisoformat(o["date"])
        except (TypeError, ValueError):
            raise ValueError("%s: bad order date %r" % (path, o.get("date")))
    return data


def load_candidates(path):
    data = _load_json(path)
    if not isinstance(data, dict) or not isinstance(data.get("searches", []), list):
        raise ValueError("%s: expected object with 'searches' list" % path)
    return data


def load_list(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read().splitlines()
    except OSError as e:
        raise ValueError("cannot read %s: %s" % (path, e))
    out = []
    for line in raw:
        p = parse_list_line(line)
        if p:
            out.append(p)
    return out


# ---------------------------------------------------------------- profile

def product_key(pid, name):
    return str(pid) if pid else "name:" + normalize(name)


def _orders_sorted(history):
    return sorted(history.get("orders", []), key=lambda o: o["date"])


def build_profile(history, today):
    stats = {}
    brand_counts = defaultdict(lambda: defaultdict(int))
    orders = _orders_sorted(history)
    for o in orders:
        per = {}
        for it in o.get("items", []):
            k = product_key(it.get("product_id"), it.get("name", ""))
            e = per.setdefault(k, {"qty": 0, "it": it})
            e["qty"] += it.get("qty", 1) or 1
            e["it"] = it
        for k, e in per.items():
            it = e["it"]
            st = stats.setdefault(k, {"qtys": [], "dates": []})
            st["qtys"].append(e["qty"])
            st["dates"].append(o["date"])
            st["name"] = it.get("name", "")
            st["brand"] = it.get("brand")
            st["category"] = it.get("category")
            st["last_price"] = it.get("price")
            if it.get("category") and it.get("brand"):
                brand_counts[it["category"]][it["brand"]] += 1
    products = {}
    for k, st in stats.items():
        dates = sorted(set(date.fromisoformat(d) for d in st["dates"]))
        gaps = [(b - a).days for a, b in zip(dates, dates[1:])]
        products[k] = {
            "name": st["name"], "brand": st["brand"], "category": st["category"],
            "order_count": len(st["qtys"]), "total_qty": sum(st["qtys"]),
            "typical_qty": max(1, int(round(statistics.median(st["qtys"])))),
            "last_date": dates[-1].isoformat(), "last_price": st["last_price"],
            "avg_interval_days": (sum(gaps) / len(gaps)) if gaps else None,
            "days_since_last": (today - dates[-1]).days,
        }
    return {"products": products,
            "brand_counts": {c: dict(b) for c, b in brand_counts.items()},
            "meta": {"orders": len(orders)}}


def co_purchases(history, min_support=3):
    count = defaultdict(int)
    pairs = defaultdict(int)
    for o in history.get("orders", []):
        keys = sorted({product_key(i.get("product_id"), i.get("name", "")) for i in o.get("items", [])})
        for k in keys:
            count[k] += 1
        for a, b in combinations(keys, 2):
            pairs[(a, b)] += 1
    out = []
    for (a, b), sup in pairs.items():
        if sup < min_support:
            continue
        out.append({"a": a, "b": b, "support": sup, "confidence": sup / count[a]})
        out.append({"a": b, "b": a, "support": sup, "confidence": sup / count[b]})
    out.sort(key=lambda r: (-r["confidence"], -r["support"], r["a"], r["b"]))
    return out


# ------------------------------------------------------------------- plan

def _r(x):
    return round(x + 0.0, 2)


def _cmp_price(c):
    return c.get("unit_price") if c.get("unit_price") is not None else c["price"]


def _promo_worth(c):
    p = c.get("promo")
    if not p or not p.get("min_qty") or p.get("total_price") is None:
        return False
    return p["total_price"] / p["min_qty"] <= c["price"] * 0.95


def _promo_saving(c, qty):
    p = c["promo"]
    mq = p["min_qty"]
    return c["price"] * qty - ((qty // mq) * p["total_price"] + (qty % mq) * c["price"])


def _top_brand(profile, category):
    bc = profile["brand_counts"].get(category)
    if not bc:
        return None
    return sorted(bc.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def plan(history, lines, candidates, today):
    profile = build_profile(history, today)
    prods = profile["products"]
    by_raw, by_norm = {}, {}
    for s in candidates.get("searches", []):
        by_raw.setdefault(s.get("line"), s.get("results", []))
        by_norm.setdefault(normalize(s.get("line", "")), s.get("results", []))

    items, missing, deals, swaps = [], [], [], []
    chosen_keys, chosen_info = set(), []
    for ln in lines:
        raw = ln["raw"]
        results = by_raw.get(raw)
        if results is None:
            results = by_norm.get(normalize(raw), [])
        stock = [c for c in results if c.get("in_stock", True)]
        if not stock:
            reason = "אזל מהמלאי" if results else "לא נמצא באתר"
            missing.append({"line": raw, "reason": reason})
            items.append({"line": raw, "query": ln["query"], "status": "missing",
                          "product_id": None, "name": None, "brand": None, "price": None,
                          "qty": ln["qty"], "line_total": 0.0, "promo_applied": False,
                          "promo_saving": 0.0, "reasons": [reason], "alternatives": []})
            continue
        cmp_vals = [_cmp_price(c) for c in stock]
        scored = []
        for c in stock:
            k = product_key(c.get("product_id"), c["name"])
            p = prods.get(k)
            cat = c.get("category") or (p or {}).get("category")
            top = _top_brand(profile, cat)
            rank = sum(1 for v in cmp_vals if v < _cmp_price(c))
            sc, why = 0.0, []
            if p:
                sc += min(10 * p["order_count"], 60)
                why.append("קנית את המוצר הזה ב-%d הזמנות" % p["order_count"])
            if top and c.get("brand") == top:
                sc += 8
                why.append("המותג המועדף עליך בקטגוריה")
            sc += similarity(ln["query"], c["name"]) * 20
            if _promo_worth(c):
                sc += 5
                why.append("במבצע")
            sc -= rank * 2
            if rank == 0 and len(stock) > 1:
                why.append("הזול ביותר מבין התוצאות")
            scored.append((sc, c, k, p, why))
        scored.sort(key=lambda t: (-t[0], t[1]["price"]))
        _, ch, key, prof, why = scored[0]
        qty = ln["qty"] or (prof["typical_qty"] if prof else 1)
        price = ch["price"]
        applied, saving = False, 0.0
        if _promo_worth(ch):
            mq = ch["promo"]["min_qty"]
            if qty >= mq:
                applied, saving = True, _promo_saving(ch, qty)
            elif mq - qty <= 2 and prof and prof["order_count"] >= 3:
                deals.append({
                    "line": raw, "product_id": ch.get("product_id"), "name": ch["name"],
                    "current_qty": qty, "suggested_qty": mq,
                    "extra_cost": _r(ch["promo"]["total_price"] - price * qty),
                    "saving_per_unit": _r(price - ch["promo"]["total_price"] / mq),
                    "description": ch["promo"].get("description", "")})
        # swap suggestion
        best = None
        for _, alt, ak, _, _ in scored[1:]:
            near = similarity(ch["name"], alt["name"]) >= 0.4 or (
                ch.get("category") and alt.get("category") and ch["category"] == alt["category"])
            if not near:
                continue
            if ch.get("unit_price") is not None and alt.get("unit_price") is not None:
                a_cmp, c_cmp = alt["unit_price"], ch["unit_price"]
            else:
                a_cmp, c_cmp = alt["price"], price
            if a_cmp > 0.9 * c_cmp:
                continue
            per = price - alt["price"]
            if per <= 0:
                per = price * (1 - a_cmp / c_cmp)
            if best is None or per > best[0]:
                best = (per, alt)
        if best:
            per, alt = best
            swaps.append({
                "line": raw,
                "from": {"id": ch.get("product_id"), "name": ch["name"], "price": price},
                "to": {"id": alt.get("product_id"), "name": alt["name"], "price": alt["price"]},
                "saving_per_unit": _r(per), "saving_total": _r(per * qty),
                "reason": "מוצר דומה זול יותר ב-%d%% לפחות" % 10})
        chosen_keys.add(key)
        chosen_info.append((key, ch))
        items.append({
            "line": raw, "query": ln["query"], "status": "ok",
            "product_id": ch.get("product_id"), "name": ch["name"], "brand": ch.get("brand"),
            "price": _r(price), "qty": qty, "line_total": _r(price * qty - saving),
            "promo_applied": applied, "promo_saving": _r(saving), "reasons": why,
            "alternatives": [{"product_id": a.get("product_id"), "name": a["name"], "price": a["price"]}
                             for _, a, _, _, _ in scored[1:4]]})

    # price changes
    watch = candidates.get("watch", []) or []
    seen, changes = set(), []
    entries = [(k, c) for k, c in chosen_info] + [
        (product_key(w.get("product_id"), w.get("name", "")), w) for w in watch]
    for k, c in entries:
        p = prods.get(k)
        if k in seen or not p or not p.get("last_price"):
            continue
        seen.add(k)
        pct = round((c["price"] - p["last_price"]) / p["last_price"] * 100, 2)
        if abs(pct) >= 3:
            changes.append({"product_id": c.get("product_id"), "name": c["name"],
                            "old": p["last_price"], "new": c["price"], "pct": pct})
    changes.sort(key=lambda x: -x["pct"])

    # forgotten staples
    oos_watch = {product_key(w.get("product_id"), w.get("name", ""))
                 for w in watch if not w.get("in_stock", True)}
    queries = [ln["query"] for ln in lines]
    forgot = []
    for k, p in prods.items():
        iv = p["avg_interval_days"]
        if p["order_count"] < 3 or iv is None or k in chosen_keys or k in oos_watch:
            continue
        if p["days_since_last"] < 0.9 * iv:
            continue
        if any(similarity(q, p["name"]) >= 0.5 for q in queries):
            continue
        ratio = p["days_since_last"] / iv if iv else float("inf")
        forgot.append((ratio, {
            "product_id": None if k.startswith("name:") else k, "name": p["name"],
            "reason": "בדרך כלל קונה כל ~%d ימים, עברו %d ימים" % (round(iv), p["days_since_last"])}, k))
    forgot.sort(key=lambda t: -t[0])
    forgot = forgot[:8]
    forgot_keys = {t[2] for t in forgot}
    forgot = [t[1] for t in forgot]

    # bought together
    goes, seen_b = [], set()
    for r in co_purchases(history):
        if r["confidence"] < 0.6 or r["a"] not in chosen_keys:
            continue
        b = r["b"]
        if b in chosen_keys or b in forgot_keys or b in seen_b or b in oos_watch:
            continue
        seen_b.add(b)
        goes.append({"with": prods[r["a"]]["name"],
                     "product_id": None if b.startswith("name:") else b,
                     "name": prods[b]["name"], "confidence": _r(r["confidence"])})
        if len(goes) >= 6:
            break

    ok = [i for i in items if i["status"] == "ok"]
    return {
        "generated": today.isoformat(), "items": items, "missing": missing,
        "deal_suggestions": deals, "swap_suggestions": swaps, "price_changes": changes,
        "maybe_forgot": forgot, "goes_with": goes,
        "estimated_total": _r(sum(i["line_total"] for i in ok)),
        "cart_actions": [{"product_id": i["product_id"], "name": i["name"], "qty": i["qty"]} for i in ok],
    }


# ----------------------------------------------------------------- report

def _m(x):
    return "%.2f" % x


def render_report(p):
    out = ["## 🛒 העגלה", "", "| מוצר | כמות | מחיר | סה\"כ | למה |", "|---|---|---|---|---|"]
    for i in p["items"]:
        if i["status"] != "ok":
            continue
        why = "; ".join(i["reasons"])
        if i["promo_applied"]:
            why += " (חיסכון ₪%s)" % _m(i["promo_saving"])
        out.append("| %s | %d | ₪%s | ₪%s | %s |" % (i["name"], i["qty"], _m(i["price"]), _m(i["line_total"]), why))
    out.append("")
    if p["missing"]:
        out += ["## ⚠️ חסר / לא נמצא", ""]
        out += ["- %s: %s" % (m["line"], m["reason"]) for m in p["missing"]] + [""]
    if p["deal_suggestions"]:
        out += ["## 💡 מבצעים ששווה לשקול", ""]
        for d in p["deal_suggestions"]:
            out.append("- %s: %s. כדאי לקחת %d במקום %d (תוספת ₪%s, חיסכון ₪%s ליחידה)" % (
                d["name"], d["description"], d["suggested_qty"], d["current_qty"],
                _m(d["extra_cost"]), _m(d["saving_per_unit"])))
        out.append("")
    if p["swap_suggestions"]:
        out += ["## 🔁 החלפות לחיסכון", ""]
        for s in p["swap_suggestions"]:
            out.append("- %s (₪%s) ← %s (₪%s): חיסכון ₪%s ליחידה, ₪%s בסה\"כ" % (
                s["from"]["name"], _m(s["from"]["price"]), s["to"]["name"], _m(s["to"]["price"]),
                _m(s["saving_per_unit"]), _m(s["saving_total"])))
        out.append("")
    if p["price_changes"]:
        out += ["## 📈 שינויי מחיר", ""]
        for c in p["price_changes"]:
            out.append("- %s: ₪%s ← ₪%s (%+.1f%%)" % (c["name"], _m(c["old"]), _m(c["new"]), c["pct"]))
        out.append("")
    if p["maybe_forgot"]:
        out += ["## 🤔 אולי שכחת", ""]
        out += ["- %s (%s)" % (f["name"], f["reason"]) for f in p["maybe_forgot"]] + [""]
    if p["goes_with"]:
        out += ["## 🧺 בדרך כלל נקנה יחד עם", ""]
        out += ["- %s (עם %s, %d%%)" % (g["name"], g["with"], round(g["confidence"] * 100))
                for g in p["goes_with"]] + [""]
    out.append("**סה\"כ משוער: ₪%s**" % _m(p["estimated_total"]))
    out.append("")
    out.append("העגלה מוכנה באתר; התשלום מתבצע על ידך.")
    return "\n".join(out) + "\n"


# -------------------------------------------------------------------- CLI

def _parse_today(s):
    return date.fromisoformat(s) if s else date.today()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Hatzi Hinam shopping planner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("profile")
    pp.add_argument("--history", required=True)
    pp.add_argument("--today")
    pl = sub.add_parser("plan")
    pl.add_argument("--history", required=True)
    pl.add_argument("--list", required=True)
    pl.add_argument("--candidates", required=True)
    pl.add_argument("--today")
    pl.add_argument("--out")
    pl.add_argument("--report")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    try:
        today = _parse_today(args.today)
        history = load_history(args.history)
        if args.cmd == "profile":
            print(json.dumps({"profile": build_profile(history, today),
                              "co_purchases": co_purchases(history)}, ensure_ascii=False, indent=2))
            return 0
        lines = load_list(args.list)
        cands = load_candidates(args.candidates)
        result = plan(history, lines, cands, today)
        report = render_report(result)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as f:
                f.write(report)
        print(report)
        return 0
    except (ValueError, OSError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
