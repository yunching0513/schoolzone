"""scripts/build_parking_space.py 的格位分類單元測試（需要 pyshp 與 shapely）。

用法：python3 tests/test_build_parking.py
"""
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bp', os.path.join(HERE, '..', 'scripts', 'build_parking_space.py'))
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)


class Classes(unittest.TestCase):
    def test_documented_codes(self):
        self.assertEqual(bp.klass('01'), 'car')          # 小型車
        self.assertEqual(bp.klass('06'), 'car')          # 大型車
        self.assertEqual(bp.klass('02'), 'moto')         # 機車
        self.assertEqual(bp.klass('22'), 'moto')         # 汽機車彈性共用（以機車格大小繪製）
        self.assertEqual(bp.klass('11'), 'zone')         # 機慢車停放區

    def test_undocumented_codes_are_excluded(self):
        for code in ('50', '60', '70', '71', ''):
            self.assertEqual(bp.klass(code), 'other')

    def test_classes_do_not_overlap(self):
        self.assertFalse(bp.CAR & bp.MOTO or bp.CAR & bp.ZONE or bp.MOTO & bp.ZONE)

    def test_all_districts_have_english_names(self):
        self.assertEqual(sorted(bp.DISTRICTS), sorted(bp.DISTRICT_EN))


if __name__ == '__main__':
    unittest.main()
