#!/usr/bin/env python3
"""
臺北街道空間 B：用航照影像偵測停放車輛的試驗（尚未用於網頁數字）

流程
  1. 下載國土測繪中心正射影像圖磚（WMTS，GoogleMapsCompatible，預設 PHOTO2025 圖層、z19 ≈ 0.27 m／像素），
     拼成試驗區影像。
  2. 以 Ultralytics YOLO11-OBB（DOTA 訓練）偵測 small／large vehicle。先做 gamma 校正提亮陰影，
     放大2倍後以1024像素、重疊256像素的切片推論，再去除重複偵測。
  3. 把停管處路邊停車格（scripts/build_parking_space.py 的快取 slots.zip）疊到影像上，輸出檢核圖。
  4. 輸出 YOLO-OBB 格式的預標註（512像素切片），供 CVAT 等工具人工修正後微調模型。

試驗結果（大安區信義安和一帶，2026-11）：現成模型漏掉大多數位於建物陰影中、以及停車場內緊密排列的車輛，
召回率太低，不能直接拿來推估面積；需要先以在地人工標註微調。

需要：pip install ultralytics pyshp pyproj
模型權重：https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11m-obb.pt（AGPL-3.0）
用法：python3 scripts/parking_ml_pilot.py --weights yolo11m-obb.pt --cache CACHE --out OUT [--lat 25.0335 --lon 121.5490 --k 8]
"""
import argparse
import json
import math
import os
import time
import urllib.request
import zipfile

import cv2
import numpy as np
import shapefile
from pyproj import Transformer
from ultralytics import YOLO

Z = 19
N = 2 ** Z
WMTS = 'https://wmts.nlsc.gov.tw/wmts/{layer}/default/GoogleMapsCompatible/{z}/{y}/{x}'
CAR = {'01', '03', '05', '06', '07', '08', '09', '10', '12', '121', '15', '17', '21', '23'}
VEHICLE = {9, 10}                                          # DOTA：large vehicle、small vehicle


def tilef(lat, lon):
    return (lon + 180) / 360 * N, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N


def lonlat(px, py):
    return px / N * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py / N))))


def mosaic(lat, lon, k, layer, tiles_dir):
    fx, fy = tilef(lat, lon)
    x0, y0 = int(fx) - k // 2, int(fy) - k // 2
    img = np.zeros((256 * k, 256 * k, 3), np.uint8)
    os.makedirs(tiles_dir, exist_ok=True)
    for i in range(k):
        for j in range(k):
            path = os.path.join(tiles_dir, f'{layer}_{Z}_{x0 + i}_{y0 + j}.jpg')
            if not os.path.exists(path):
                url = WMTS.format(layer=layer, z=Z, x=x0 + i, y=y0 + j)
                open(path, 'wb').write(urllib.request.urlopen(url, timeout=30).read())
                time.sleep(0.2)                            # 對公共圖磚服務保持禮貌
            img[256 * j:256 * (j + 1), 256 * i:256 * (i + 1)] = cv2.imread(path)
    return img, x0, y0


def detect(model, bgr, scale=2, gamma=0.55, conf=0.15):
    img = np.clip(255 * (bgr / 255.0) ** gamma, 0, 255).astype(np.uint8)
    big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    dets = []
    for x in range(0, big.shape[1], 768):
        for y in range(0, big.shape[0], 768):
            r = model.predict(np.ascontiguousarray(big[y:y + 1024, x:x + 1024]), imgsz=1024, conf=conf, verbose=False)[0]
            for p, poly, k, c in zip(r.obb.xywhr.tolist(), r.obb.xyxyxyxy.tolist(), r.obb.cls.tolist(), r.obb.conf.tolist()):
                if int(k) in VEHICLE:
                    dets.append({'cx': (p[0] + x) / scale, 'cy': (p[1] + y) / scale, 'conf': c,
                                 'poly': [[(q[0] + x) / scale, (q[1] + y) / scale] for q in poly]})
    dets.sort(key=lambda d: -d['conf'])
    keep = []
    for d in dets:                                         # 重疊切片的重複偵測：中心距離 < 4 像素者只留信心最高的
        if all((d['cx'] - q['cx']) ** 2 + (d['cy'] - q['cy']) ** 2 > 16 for q in keep):
            keep.append(d)
    return keep


def slot_polygons(cache, x0, y0, k):
    """回傳試驗區內的停車格（像素座標）與種類。"""
    z = zipfile.ZipFile(os.path.join(cache, 'slots.zip'))
    stem = next(n for n in z.namelist() if n.endswith('.shp'))[:-4]
    import io
    part = lambda ext: io.BytesIO(z.read(stem + ext))
    r = shapefile.Reader(shp=part('.shp'), shx=part('.shx'), dbf=part('.dbf'), encoding='utf-8')
    to_wgs = Transformer.from_crs('EPSG:3826', 'EPSG:4326', always_xy=True)
    to_tm = Transformer.from_crs('EPSG:4326', 'EPSG:3826', always_xy=True)
    (ax, ay), (bx, by) = to_tm.transform(*lonlat(x0, y0 + k)), to_tm.transform(*lonlat(x0 + k, y0))
    out = []
    for s in r.iterShapeRecords(fields=['pktype'], bbox=[ax, ay, bx, by]):
        pts = []
        for X, Y in s.shape.points:
            lon, lat = to_wgs.transform(X, Y)
            tx, ty = tilef(lat, lon)
            pts.append([(tx - x0) * 256, (ty - y0) * 256])
        out.append(('car' if s.record[0] in CAR else 'moto', pts))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', required=True)
    ap.add_argument('--cache', required=True, help='build_parking_space.py 的下載快取（需含 slots.zip）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--lat', type=float, default=25.0335)
    ap.add_argument('--lon', type=float, default=121.5490)
    ap.add_argument('--k', type=int, default=8, help='每邊圖磚數')
    ap.add_argument('--layer', default='PHOTO2025')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    img, x0, y0 = mosaic(a.lat, a.lon, a.k, a.layer, os.path.join(a.out, 'tiles'))
    cv2.imwrite(os.path.join(a.out, 'raw.png'), img)
    dets = detect(YOLO(a.weights), img)
    slots = slot_polygons(a.cache, x0, y0, a.k)

    ov = img.copy()
    for kind, pts in slots:
        cv2.polylines(ov, [np.array(pts, np.int32)], True, (0, 120, 255) if kind == 'car' else (255, 160, 40), 1)
    for d in dets:
        cv2.polylines(ov, [np.array(d['poly'], np.int32)], True, (255, 0, 255) if d['conf'] >= 0.25 else (0, 255, 255), 2)
    cv2.imwrite(os.path.join(a.out, 'check.png'), ov)

    # 預標註：512 像素切片，YOLO-OBB 格式（class x1 y1 … x4 y4，座標正規化），類別 0 = vehicle
    lab = os.path.join(a.out, 'labels'); imd = os.path.join(a.out, 'images')
    os.makedirs(lab, exist_ok=True); os.makedirs(imd, exist_ok=True)
    S = 512
    for x in range(0, img.shape[1], S):
        for y in range(0, img.shape[0], S):
            name = f'{a.layer}_{x0}_{y0}_{x}_{y}'
            cv2.imwrite(os.path.join(imd, name + '.jpg'), img[y:y + S, x:x + S])
            lines = []
            for d in dets:
                if x <= d['cx'] < x + S and y <= d['cy'] < y + S:
                    xy = ' '.join(f'{min(max((px - x) / S, 0), 1):.5f} {min(max((py - y) / S, 0), 1):.5f}' for px, py in d['poly'])
                    lines.append('0 ' + xy)
            open(os.path.join(lab, name + '.txt'), 'w').write('\n'.join(lines))
    m_per_px = 156543.03 * math.cos(math.radians(a.lat)) / N
    summary = {'layer': a.layer, 'center': [a.lat, a.lon], 'tiles': a.k * a.k, 'm_per_px': round(m_per_px, 3),
               'side_m': round(256 * a.k * m_per_px), 'detections': len(dets),
               'detections_conf25': sum(d['conf'] >= 0.25 for d in dets),
               'slots': {'car': sum(k == 'car' for k, _ in slots), 'moto': sum(k == 'moto' for k, _ in slots)}}
    json.dump({'summary': summary, 'detections': dets}, open(os.path.join(a.out, 'detections.json'), 'w'), indent=1)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
