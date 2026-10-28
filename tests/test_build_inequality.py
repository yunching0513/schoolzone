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


if __name__ == '__main__':
    unittest.main()
