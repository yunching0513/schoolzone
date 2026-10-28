"""scripts/build_inequality.py 的統計函式單元測試（只用標準函式庫）。

用法：python3 tests/test_build_inequality.py
"""
import importlib.util
import math
import os
import random
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bi', os.path.join(HERE, '..', 'scripts', 'build_inequality.py'))
bi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bi)


class Stats(unittest.TestCase):
    def test_ols_recovers_exact_coefficients(self):
        rnd = random.Random(1)
        X = [[1.0, rnd.uniform(0, 10), rnd.uniform(20, 60)] for _ in range(50)]
        y = [2.0 + 0.5 * a - 0.03 * b for _, a, b in X]
        m = bi.ols(X, y)
        for got, want in zip(m['b'], [2.0, 0.5, -0.03]):
            self.assertAlmostEqual(got, want, places=9)
        self.assertAlmostEqual(m['r2'], 1.0, places=9)

    def test_ols_standard_error_matches_closed_form(self):
        # 單一迴歸：se(b) = sqrt(s² / Σ(x−x̄)²)
        xs = [1, 2, 3, 4, 5, 6, 7, 8]
        ys = [1.1, 1.9, 3.2, 3.8, 5.3, 5.9, 7.2, 7.8]
        m = bi.ols([[1.0, x] for x in xs], ys)
        n, mx = len(xs), sum(xs) / len(xs)
        res = [y - (m['b'][0] + m['b'][1] * x) for x, y in zip(xs, ys)]
        s2 = sum(e * e for e in res) / (n - 2)
        self.assertAlmostEqual(m['se'][1], math.sqrt(s2 / sum((x - mx) ** 2 for x in xs)), places=12)

    def test_spearman_monotone_and_ties(self):
        self.assertAlmostEqual(bi.spearman([1, 2, 3, 4], [10, 20, 35, 100]), 1.0)
        self.assertAlmostEqual(bi.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertEqual(bi.ranks([5, 1, 5, 2]), [2.5, 0.0, 2.5, 1.0])

    def test_bootstrap_is_reproducible(self):
        rows = [{'x': i, 'y': i * 2 + (i % 3)} for i in range(40)]
        stat = lambda s: bi.spearman([r['x'] for r in s], [r['y'] for r in s])
        self.assertEqual(bi.bootstrap(rows, stat), bi.bootstrap(rows, stat))
        lo, hi = bi.bootstrap(rows, stat)
        self.assertLessEqual(lo, hi)

    def test_pct_conversion(self):
        self.assertAlmostEqual(bi.pct(math.log(1.025)), 2.5, places=9)
        self.assertEqual(bi.pct(0), 0)

    def test_design_matrix_region_dummies(self):
        rows = [{'gdp_pc': 1000, 'gini': 30, 'group': g} for g in bi.GROUPS]
        X = bi.design(rows, gini=True, region=True)
        self.assertEqual(X[0][3:], [0.0, 0.0, 0.0])           # 第一組為基準
        self.assertEqual([r[3:] for r in X[1:]], [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])


spec_tw = importlib.util.spec_from_file_location('bti', os.path.join(HERE, '..', 'scripts', 'build_taiwan_inequality.py'))
bti = importlib.util.module_from_spec(spec_tw)
spec_tw.loader.exec_module(bti)


class TaiwanStats(unittest.TestCase):
    def test_single_lognormal_gini_matches_closed_form(self):
        # 單一對數常態：吉尼係數 = 2Φ(σ/√2) − 1；中位數與 Q3/Q1 也應還原
        from statistics import NormalDist
        sigma = 0.8
        q1, q3 = 500 * math.exp(-0.6744898 * sigma), 500 * math.exp(0.6744898 * sigma)
        gini, med, iqr = bti.lognormal_mixture([{'median': 500, 'q1': q1, 'q3': q3, 'units': 1000}], K=4000)
        self.assertAlmostEqual(gini, 2 * NormalDist().cdf(sigma / math.sqrt(2)) - 1, places=3)
        self.assertAlmostEqual(med / 500, 1, places=2)
        self.assertAlmostEqual(iqr, q3 / q1, delta=0.02)

    def test_mixture_of_different_levels_is_more_unequal(self):
        t = lambda m: {'median': m, 'q1': m * 0.6, 'q3': m * 1.6, 'units': 100}
        g_same = bti.lognormal_mixture([t(500), t(500)])[0]
        g_apart = bti.lognormal_mixture([t(300), t(900)])[0]
        self.assertGreater(g_apart, g_same)                    # 組間差距會推高混合後的不均

    def test_quasi_poisson_recovers_coefficients(self):
        rnd = random.Random(3)
        X, off, y = [], [], []
        for _ in range(300):
            x = rnd.uniform(-1, 1); o = math.log(rnd.uniform(1, 50))
            X.append([1.0, x]); off.append(o); y.append(math.exp(0.7 - 0.4 * x + o))   # 無雜訊的期望值
        b, se, phi = bti.quasi_poisson(X, y, off)
        self.assertAlmostEqual(b[0], 0.7, places=6)
        self.assertAlmostEqual(b[1], -0.4, places=6)

    def test_effect_scales(self):
        self.assertAlmostEqual(math.exp(-0.2 * bti.EFFECT['density']) - 1, 2 ** -0.2 - 1)
        self.assertAlmostEqual(bti.EFFECT['iqr'], math.log(1.1))


if __name__ == '__main__':
    unittest.main()
