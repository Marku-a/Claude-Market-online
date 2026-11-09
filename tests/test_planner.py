import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(ROOT, ".claude", "skills", "hatzi-hinam-shopper")
sys.path.insert(0, os.path.join(SKILL, "scripts"))
import planner  # noqa: E402

TODAY = date(2026, 11, 9)


def order(oid, d, *items):
    return {"id": oid, "date": d, "items": [
        {"product_id": i[0], "name": i[1], "brand": i[2], "category": i[3], "qty": i[4], "price": i[5]}
        for i in items]}


def cand(pid, name, price, **kw):
    d = {"product_id": pid, "name": name, "price": price, "in_stock": True}
    d.update(kw)
    return d


def run_plan(history, lines, searches, watch=None):
    parsed = [planner.parse_list_line(x) for x in lines]
    return planner.plan(history, parsed, {"searches": searches, "watch": watch or []}, TODAY)


MILK = ("1", "חלב תנובה 3% 1 ליטר", "תנובה", "חלב")
BREAD = ("2", "לחם אחיד", "אנגל", "מאפים")
EGGS = ("3", "ביצים L", "תנובה", "ביצים")


def hist(*orders):
    return {"orders": list(orders)}


class TextTests(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(planner.normalize("חָלָב,  תנובה!! 3%"), "חלב תנובה 3%")
        self.assertEqual(planner.normalize("  Milk-2 "), "milk 2")

    def test_similarity(self):
        self.assertEqual(planner.similarity("", "חלב"), 0.0)
        self.assertEqual(planner.similarity("חלב 3%", "חלב 3%"), 1.0)
        self.assertAlmostEqual(planner.similarity("חלב 3%", "חלב"), 0.5)

    def test_parse(self):
        p = planner.parse_list_line("2 חלב")
        self.assertEqual((p["qty"], p["query"]), (2, "חלב"))
        for s in ("חלב x2", "חלב X2", "חלב ×2", "חלב *2", "חלב×2"):
            p = planner.parse_list_line(s)
            self.assertEqual((p["qty"], p["query"]), (2, "חלב"), s)
        p = planner.parse_list_line("חלב 3%")
        self.assertEqual((p["qty"], p["query"]), (None, "חלב 3%"))
        p = planner.parse_list_line("3% חלב")
        self.assertIsNone(p["qty"])
        p = planner.parse_list_line("חלב 2")
        self.assertEqual((p["qty"], p["query"]), (None, "חלב 2"))
        p = planner.parse_list_line("100 חלב")
        self.assertIsNone(p["qty"])
        self.assertIsNone(planner.parse_list_line("   "))
        self.assertIsNone(planner.parse_list_line("# הערה"))


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.h = hist(
            order("a", "2026-10-01", (*MILK, 2, 6.9), (*BREAD, 1, 7.5)),
            order("b", "2026-10-11", (*MILK, 3, 7.0), (*BREAD, 1, 7.5)),
            order("c", "2026-10-31", (*MILK, 2, 7.1), (*BREAD, 1, 7.5)))

    def test_profile(self):
        pr = planner.build_profile(self.h, TODAY)
        m = pr["products"]["1"]
        self.assertEqual(m["order_count"], 3)
        self.assertEqual(m["total_qty"], 7)
        self.assertEqual(m["typical_qty"], 2)
        self.assertEqual(m["last_price"], 7.1)
        self.assertEqual(m["last_date"], "2026-10-31")
        self.assertEqual(m["avg_interval_days"], 15.0)
        self.assertEqual(m["days_since_last"], 9)
        self.assertEqual(pr["brand_counts"]["חלב"], {"תנובה": 3})
        self.assertEqual(pr["meta"]["orders"], 3)

    def test_interval_none_and_name_key(self):
        h = hist({"id": "x", "date": "2026-10-01", "items": [{"name": "עגבניות!", "qty": 1, "price": 5}]})
        pr = planner.build_profile(h, TODAY)
        k = "name:עגבניות"
        self.assertIn(k, pr["products"])
        self.assertIsNone(pr["products"][k]["avg_interval_days"])

    def test_co_purchases(self):
        h = hist(
            order("a", "2026-10-01", (*MILK, 1, 7), (*BREAD, 1, 7), (*EGGS, 1, 12)),
            order("b", "2026-10-08", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("c", "2026-10-15", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("d", "2026-10-22", (*BREAD, 1, 7)))
        co = planner.co_purchases(h)
        d = {(r["a"], r["b"]): r for r in co}
        self.assertEqual(d[("1", "2")]["support"], 3)
        self.assertAlmostEqual(d[("1", "2")]["confidence"], 1.0)
        self.assertAlmostEqual(d[("2", "1")]["confidence"], 0.75)
        self.assertNotIn(("1", "3"), d)
        self.assertEqual(co[0]["confidence"], 1.0)


class PlanTests(unittest.TestCase):
    def test_prefers_history_over_cheaper(self):
        h = hist(*[order(str(i), "2026-10-%02d" % (i + 1), (*MILK, 2, 7.0)) for i in range(4)])
        res = run_plan(h, ["חלב 3%"], [{"line": "חלב 3%", "results": [
            cand("9", "חלב כלשהו 3%", 5.0, brand="X", category="חלב"),
            cand("1", MILK[1], 7.4, brand="תנובה", category="חלב")]}])
        it = res["items"][0]
        self.assertEqual(it["product_id"], "1")
        self.assertEqual(it["qty"], 2)
        self.assertIn("קנית את המוצר הזה ב-4 הזמנות", it["reasons"])
        self.assertEqual(it["alternatives"][0]["product_id"], "9")

    def test_cheapest_without_history(self):
        res = run_plan(hist(), ["שמן"], [{"line": "שמן", "results": [
            cand("a", "שמן קנולה", 12.0), cand("b", "שמן קנולה", 9.0), cand("c", "שמן קנולה", 10.0)]}])
        it = res["items"][0]
        self.assertEqual(it["product_id"], "b")
        self.assertEqual(it["qty"], 1)
        self.assertIn("הזול ביותר מבין התוצאות", it["reasons"])

    def test_missing(self):
        res = run_plan(hist(), ["אורז", "שוקולד"], [
            {"line": "אורז", "results": [cand("a", "אורז", 9, in_stock=False)]},
            {"line": "שוקולד", "results": []}])
        reasons = {m["line"]: m["reason"] for m in res["missing"]}
        self.assertEqual(reasons, {"אורז": "אזל מהמלאי", "שוקולד": "לא נמצא באתר"})
        self.assertTrue(all(i["status"] == "missing" for i in res["items"]))
        self.assertEqual(res["cart_actions"], [])
        self.assertEqual(res["estimated_total"], 0.0)

    def test_line_match_by_normalized(self):
        res = run_plan(hist(), ["חלב  3%!"], [{"line": "חלב 3%", "results": [cand("a", "חלב 3%", 6)]}])
        self.assertEqual(res["items"][0]["status"], "ok")

    def test_promo_applied(self):
        promo = {"description": "2 ב-12", "min_qty": 2, "total_price": 12.0}
        res = run_plan(hist(), ["3 חלב"], [{"line": "3 חלב", "results": [
            cand("1", "חלב", 7.4, promo=promo)]}])
        it = res["items"][0]
        self.assertTrue(it["promo_applied"])
        self.assertEqual(it["promo_saving"], 2.8)
        self.assertEqual(it["line_total"], 19.4)
        self.assertEqual(res["estimated_total"], 19.4)

    def _staple_hist(self, n):
        return hist(*[order(str(i), "2026-10-%02d" % (i + 1), (*MILK, 1, 7.4)) for i in range(n)])

    def test_deal_suggestion(self):
        promo = {"description": "2 ב-12", "min_qty": 2, "total_price": 12.0}
        searches = [{"line": "חלב", "results": [cand("1", MILK[1], 7.4, promo=promo)]}]
        res = run_plan(self._staple_hist(3), ["חלב"], searches)
        self.assertFalse(res["items"][0]["promo_applied"])
        d = res["deal_suggestions"][0]
        self.assertEqual((d["current_qty"], d["suggested_qty"]), (1, 2))
        self.assertEqual(d["extra_cost"], 4.6)
        self.assertEqual(d["saving_per_unit"], 1.4)
        res = run_plan(self._staple_hist(2), ["חלב"], searches)
        self.assertEqual(res["deal_suggestions"], [])

    def test_swap_threshold(self):
        def swaps(alt_price):
            r = run_plan(hist(), ["2 חלב"], [{"line": "2 חלב", "results": [
                cand("1", "חלב תנובה 3%", 10.0, brand="תנובה"),
                cand("2", "חלב טרה 3%", alt_price)]}])
            return r["swap_suggestions"], r["items"][0]
        # chosen = cheaper alt when no history; force choice via history
        h = hist(*[order(str(i), "2026-10-%02d" % (i + 1), ("1", "חלב תנובה 3%", "תנובה", "חלב", 2, 10.0))
                   for i in range(4)])

        def go(alt_price):
            return run_plan(h, ["2 חלב"], [{"line": "2 חלב", "results": [
                cand("1", "חלב תנובה 3%", 10.0, brand="תנובה"),
                cand("2", "חלב טרה 3%", alt_price)]}])["swap_suggestions"]
        self.assertEqual(len(go(9.0)), 1)
        self.assertEqual(go(9.01), [])
        s = go(8.0)[0]
        self.assertEqual((s["saving_per_unit"], s["saving_total"]), (2.0, 4.0))
        self.assertEqual(s["to"]["id"], "2")

    def test_price_change_threshold(self):
        h = hist(order("a", "2026-10-01", ("1", "מוצר א", "x", "c", 1, 10.0),
                       ("2", "מוצר ב", "x", "c", 1, 10.0), ("3", "מוצר ג", "x", "c", 1, 10.0),
                       ("4", "מוצר ד", "x", "c", 1, 10.0)))
        res = run_plan(h, ["מוצר א"], [{"line": "מוצר א", "results": [cand("1", "מוצר א", 10.3)]}],
                       watch=[cand("2", "מוצר ב", 10.29), cand("3", "מוצר ג", 9.7), cand("4", "מוצר ד", 9.71)])
        got = {c["product_id"]: c["pct"] for c in res["price_changes"]}
        self.assertEqual(got, {"1": 3.0, "3": -3.0})
        self.assertEqual([c["product_id"] for c in res["price_changes"]], ["1", "3"])

    def _periodic(self):
        return hist(
            order("a", "2026-08-01", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("b", "2026-08-15", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("c", "2026-08-29", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("d", "2026-10-31", (*BREAD, 1, 7)))

    def test_maybe_forgot(self):
        res = run_plan(self._periodic(), ["לחם"], [{"line": "לחם", "results": [cand("2", BREAD[1], 7)]}])
        self.assertEqual([f["product_id"] for f in res["maybe_forgot"]], ["1"])
        self.assertIn("14", res["maybe_forgot"][0]["reason"])

    def test_maybe_forgot_excluded_when_on_list(self):
        res = run_plan(self._periodic(), ["חלב תנובה 3% 1 ליטר"], [
            {"line": "חלב תנובה 3% 1 ליטר", "results": []}])
        self.assertFalse([f for f in res["maybe_forgot"] if f["product_id"] == "1"])

    def test_goes_with(self):
        h = hist(*[order(str(i), d, (*MILK, 1, 7), (*EGGS, 1, 12))
                   for i, d in enumerate(("2026-10-12", "2026-10-26", "2026-11-09"))])
        res = run_plan(h, ["חלב"], [{"line": "חלב", "results": [cand("1", MILK[1], 7)]}])
        self.assertEqual(len(res["goes_with"]), 1)
        g = res["goes_with"][0]
        self.assertEqual((g["product_id"], g["with"], g["confidence"]), ("3", MILK[1], 1.0))
        # not suggested when already in plan
        res = run_plan(h, ["חלב", "ביצים"], [{"line": "חלב", "results": [cand("1", MILK[1], 7)]},
                                              {"line": "ביצים", "results": [cand("3", EGGS[1], 12)]}])
        self.assertEqual(res["goes_with"], [])


class ReportTests(unittest.TestCase):
    def test_report(self):
        h = hist(*[order(str(i), "2026-10-%02d" % (i + 1), (*MILK, 1, 7)) for i in range(3)])
        res = run_plan(h, ["חלב", "שוקולד"], [{"line": "חלב", "results": [cand("1", MILK[1], 7.5)]}])
        rep = planner.render_report(res)
        for s in ("## 🛒 העגלה", "## ⚠️ חסר / לא נמצא", "## 📈 שינויי מחיר", "**סה\"כ משוער: ₪7.50**"):
            self.assertIn(s, rep)
        self.assertNotIn("## 🔁", rep)
        self.assertNotIn("## 💡", rep)


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(SKILL, "scripts", "planner.py"), *args],
                              capture_output=True, text=True, encoding="utf-8")

    def test_plan_end_to_end(self):
        ex = os.path.join(SKILL, "examples")
        with tempfile.TemporaryDirectory() as td:
            out, rep = os.path.join(td, "plan.json"), os.path.join(td, "r.md")
            r = self.run_cli("plan", "--history", os.path.join(ex, "history.json"),
                             "--list", os.path.join(ex, "list.txt"),
                             "--candidates", os.path.join(ex, "candidates.json"),
                             "--today", "2026-11-09", "--out", out, "--report", rep)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("העגלה", r.stdout)
            self.assertTrue(os.path.getsize(out) > 0)
            with open(rep, encoding="utf-8") as f:
                self.assertIn("העגלה", f.read())

    def test_profile(self):
        ex = os.path.join(SKILL, "examples", "history.json")
        r = self.run_cli("profile", "--history", ex, "--today", "2026-11-09")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("co_purchases", r.stdout)

    def test_missing_file(self):
        r = self.run_cli("profile", "--history", "/nonexistent/h.json")
        self.assertEqual(r.returncode, 2)
        self.assertIn("error", r.stderr)




class TestNormalizeEdgeCases(unittest.TestCase):
    def test_maqaf_splits_words(self):
        self.assertEqual(planner.normalize("חלב־טרה"), "חלב טרה")

    def test_latin_word_ending_in_x_is_not_qty(self):
        r = planner.parse_list_line("MAX2")
        self.assertIsNone(r["qty"])
        self.assertEqual(planner.parse_list_line("במבה x3")["qty"], 3)
        self.assertEqual(planner.parse_list_line("במבה×3")["qty"], 3)


class ReviewFixTests(unittest.TestCase):
    def _fav(self, qty=2, price=10.0):
        return hist(*[order(str(i), "2026-10-%02d" % (i + 1), ("1", "חלב תנובה 3%", "תנובה", "חלב", qty, price))
                      for i in range(4)])

    def test_swap_accounts_for_applied_promo(self):
        promo = {"description": "2 ב-12", "min_qty": 2, "total_price": 12.0}
        h = hist(*[order(str(i), "2026-10-%02d" % (i + 1), (*MILK, 2, 7.0)) for i in range(4)])
        res = run_plan(h, ["2 חלב"], [{"line": "2 חלב", "results": [
            cand("1", MILK[1], 7.4, brand="תנובה", category="חלב", promo=promo),
            cand("2", "חלב טרה 3% 1 ליטר", 6.2, category="חלב")]}])
        self.assertEqual(res["items"][0]["product_id"], "1")
        self.assertEqual(res["swap_suggestions"], [])

    def test_swap_still_worth_after_promo(self):
        promo = {"description": "2 ב-14", "min_qty": 2, "total_price": 14.0}
        res = run_plan(self._fav(), ["2 חלב"], [{"line": "2 חלב", "results": [
            cand("1", "חלב תנובה 3%", 10.0, brand="תנובה"),
            cand("2", "חלב טרה 3%", 9.5, promo=promo)]}])
        s = res["swap_suggestions"][0]
        self.assertEqual((s["saving_total"], s["saving_per_unit"]), (6.0, 3.0))

    def test_zero_price_no_crash(self):
        res = run_plan(hist(), ["שקית"], [{"line": "שקית", "results": [
            cand("1", "שקית", 0.0), cand("2", "שקית גדולה", 0.0)]}])
        self.assertEqual(res["swap_suggestions"], [])
        self.assertEqual(res["estimated_total"], 0.0)

    def test_mixed_unit_price_uses_price(self):
        h = hist(*[order(str(i), "2026-10-%02d" % (i + 1), ("1", "קפה נמס עלית 200 גרם", "עלית", "קפה", 1, 21.9))
                   for i in range(4)])
        res = run_plan(h, ["קפה"], [{"line": "קפה", "results": [
            cand("1", "קפה נמס עלית 200 גרם", 21.9, unit_price=10.95, brand="עלית", category="קפה"),
            cand("2", "קפה נמס עלית 100 גרם", 13.5, brand="עלית", category="קפה")]}])
        self.assertEqual(res["items"][0]["product_id"], "1")
        self.assertEqual(res["swap_suggestions"], [])

    def test_typical_qty_half_up(self):
        h = hist(order("a", "2026-10-01", (*MILK, 2, 7)), order("b", "2026-10-08", (*MILK, 3, 7)))
        self.assertEqual(planner.build_profile(h, TODAY)["products"]["1"]["typical_qty"], 3)

    def test_forgot_excludes_any_result_key(self):
        h = hist(
            order("a", "2026-08-01", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("b", "2026-08-15", (*MILK, 1, 7), (*BREAD, 1, 7)),
            order("c", "2026-08-29", (*MILK, 1, 7), (*BREAD, 1, 7)))
        res = run_plan(h, ["לחם", "אורז"], [
            {"line": "לחם", "results": [cand("2", BREAD[1], 7)]},
            {"line": "אורז", "results": [cand("1", MILK[1], 7, in_stock=False)]}])
        self.assertEqual(res["maybe_forgot"], [])

    def test_merge_same_product(self):
        res = run_plan(hist(), ["חלב", "2 חלב"], [
            {"line": "חלב", "results": [cand("1", "חלב", 7)]},
            {"line": "2 חלב", "results": [cand("1", "חלב", 7)]}])
        self.assertEqual(res["cart_actions"], [{"product_id": "1", "name": "חלב", "qty": 3}])
        self.assertEqual(len(res["merged"]), 1)
        self.assertIn("מוצר זה הופיע בכמה שורות ברשימה — אוחד", planner.render_report(res))

    def test_loader_validation(self):
        with tempfile.TemporaryDirectory() as td:
            def w(name, text):
                path = os.path.join(td, name)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
                return path
            with self.assertRaises(ValueError):
                planner.load_candidates(w("c1.json", '{"searches":[{"line":"x","results":[{"name":"a"}]}]}'))
            with self.assertRaises(ValueError):
                planner.load_candidates(w("c2.json", '{"searches":[],"watch":[{"name":"a","price":true}]}'))
            with self.assertRaises(ValueError):
                planner.load_history(w("h1.json", '{"orders":[{"id":"1","date":"2026-10-01","items":'
                                                  '[{"name":"a","qty":0,"price":1}]}]}'))
            c = planner.load_candidates(w("c3.json", '{"searches":[{"line":"x","results":[{"name":"a",'
                                                     '"price":5,"promo":{"min_qty":0,"total_price":3}}]}]}'))
            self.assertNotIn("promo", c["searches"][0]["results"][0])

    def test_bom(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "l.txt")
            with open(path, "w", encoding="utf-8-sig") as f:
                f.write("# הערה\n2 חלב\n")
            lines = planner.load_list(path)
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["qty"], 2)
            with open(path, "w", encoding="utf-8-sig") as f:
                f.write("2 חלב\n")
            self.assertEqual(planner.load_list(path)[0]["qty"], 2)
            hp = os.path.join(td, "h.json")
            with open(hp, "w", encoding="utf-8-sig") as f:
                f.write('{"orders":[]}')
            self.assertEqual(planner.load_history(hp), {"orders": []})


class CliGuardTests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, os.path.join(SKILL, "scripts", "planner.py"), *args],
                              capture_output=True, text=True, encoding="utf-8")

    def test_candidate_without_price_exit_2(self):
        ex = os.path.join(SKILL, "examples")
        with tempfile.TemporaryDirectory() as td:
            cp = os.path.join(td, "c.json")
            with open(cp, "w", encoding="utf-8") as f:
                f.write('{"searches":[{"line":"חלב","results":[{"name":"חלב"}]}]}')
            r = self.run_cli("plan", "--history", os.path.join(ex, "history.json"),
                             "--list", os.path.join(ex, "list.txt"), "--candidates", cp)
            self.assertEqual(r.returncode, 2)
            self.assertIn("price", r.stderr)

    def test_refuse_overwriting_input(self):
        ex = os.path.join(SKILL, "examples")
        with tempfile.TemporaryDirectory() as td:
            lst = os.path.join(td, "l.txt")
            with open(lst, "w", encoding="utf-8") as f:
                f.write("חלב\n")
            r = self.run_cli("plan", "--history", os.path.join(ex, "history.json"), "--list", lst,
                             "--candidates", os.path.join(ex, "candidates.json"), "--report", lst)
            self.assertEqual(r.returncode, 2)
            with open(lst, encoding="utf-8") as f:
                self.assertEqual(f.read(), "חלב\n")


if __name__ == "__main__":
    unittest.main()
