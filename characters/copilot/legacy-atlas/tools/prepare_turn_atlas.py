#!/usr/bin/env python3
"""Build an eye-free, piecewise-affine pose atlas from the five supplied renders.

This is landmark view interpolation, not a recovered 3-D model. Coordinates in
SOURCE are measured on the original sheet, so the artwork is never rewritten.
Run with the project's Python environment; Pillow, NumPy and SciPy are required.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import zlib

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import (
    binary_dilation, binary_erosion, binary_fill_holes, distance_transform_edt, label,
    map_coordinates, gaussian_filter, zoom,
)
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import spsolve
from scipy.spatial import Delaunay
from scipy.interpolate import CubicSpline, PchipInterpolator


ROOT = Path(__file__).resolve().parents[4]
WIDTH, HEIGHT, STEPS = 336, 304, 33
DIRECTIONS = (
    "right", "left", "up", "down",
    "up_right", "up_left", "down_right", "down_left",
)
SCALE = 0.96
# Clockwise goggle contours, starting at the upper-left; inner contours use
# the same correspondence. The profile's far goggle collapses into its rim.
SOURCE = {
    "front": {
        "crop": (136, 90, 466, 354),
        "goggles": [
            [(214,119),(251,108),(284,119),(298,166),
             (285,210),(246,224),(204,215),(188,167)],
            [(318,119),(350,109),(391,128),(413,173),
             (397,214),(353,225),(314,212),(302,166)],
        ],
        "lenses": [
            [(221,137),(250,132),(272,139),(282,166),
             (276,193),(244,204),(219,195),(212,166)],
            [(326,137),(352,133),(377,144),(389,168),
             (381,196),(354,204),(329,196),(319,166)],
        ],
        "visor": [(204,220),(300,225),(396,221),(405,257),
                  (402,296),(301,326),(199,296),(194,258)],
        "ear": (164, 252, 21, 49),
        "seam": [(192,204),(178,251),(177,306),(301,347),(425,308),
                 (422,253),(418,200),(301,95)],
        "eyes": [(252,237,285,290), (316,237,348,290)],
        "axis": [(300,111),(300,166),(300,216),(300,260),
                 (301,326),(301,339)],
    },
    "quarter": {
        "crop": (630, 78, 940, 332),
        "goggles": [
            [(736,111),(773,94),(817,98),(841,147),
             (832,187),(794,208),(750,191),(725,145)],
            [(845,99),(871,98),(901,118),(922,165),
             (916,191),(881,209),(850,195),(841,145)],
        ],
        "lenses": [
            [(753,127),(782,113),(811,116),(825,147),
             (828,179),(794,188),(764,185),(749,156)],
            [(859,119),(872,117),(890,130),(902,151),
             (907,177),(889,188),(870,181),(859,151)],
        ],
        "visor": [(735,197),(840,208),(906,205),(911,239),
                  (900,280),(829,307),(730,278),(726,240)],
        "ear": (665, 236, 30, 52),
        "far_ear": (927, 235, 7, 26),
        "seam": [(706,180),(701,236),(701,295),(822,328),(915,292),
                 (924,239),(924,200),(783,82)],
        "eyes": [(797,219,829,273), (853,219,881,271)],
        "axis": [(834,99),(841,147),(842,207),(840,252),
                 (834,307),(831,320)],
    },
    "side": {
        "crop": (1148, 88, 1452, 366),
        "goggles": [
            [(1340,117),(1368,106),(1395,118),(1424,164),
             (1440,211),(1421,230),(1382,203),(1348,157)],
            [(1395,107),(1398,108),(1408,118),(1435,158),
             (1448,219),(1446,230),(1443,225),(1428,160)],
        ],
        "lenses": [
            [(1371,131),(1383,125),(1397,132),(1418,171),
             (1425,202),(1413,210),(1391,184),(1375,148)],
            [(1400,118),(1403,120),(1413,134),(1432,170),
             (1444,214),(1443,220),(1441,217),(1427,170)],
        ],
        "visor": [(1349,218),(1421,231),(1429,233),(1431,270),
                  (1418,333),(1416,338),(1349,314),(1347,264)],
        "ear": (1254, 263, 61, 63),
        "seam": [(1327,208),(1327,272),(1325,330),(1410,362),(1412,363),
                 (1437,275),(1447,228),(1282,90)],
        "eyes": [(1406,246,1426,301), None],
        "axis": [(1394,110),(1424,160),(1430,231),(1425,273),
                 (1415,339),(1414,349)],
    },
    "down_diagonal": {
        "crop": (374, 462, 685, 761),
        "goggles": [
            [(500,545),(539,534),(574,527),(605,573),
             (614,623),(571,662),(524,659),(489,603)],
            [(597,516),(620,504),(645,506),(672,548),
             (680,590),(661,623),(638,635),(615,583)],
        ],
        "lenses": [
            [(517,569),(544,558),(570,554),(590,584),
             (595,626),(568,643),(538,641),(516,615)],
            [(624,538),(638,533),(649,542),(662,568),
             (663,590),(650,615),(637,614),(627,579)],
        ],
        "visor": [(493,641),(615,647),(658,629),(653,673),
                  (637,708),(601,735),(492,723),(489,681)],
        "ear": (414, 658, 36, 54),
        "far_ear": (663, 670, 1.2, 10),
        "seam": [(462,626),(460,684),(460,733),(596,749),(646,716),
                 (665,670),(678,628),(521,465)],
        "eyes": [(566,661,602,717), (618,644,646,700)],
        "axis": [(590,521),(613,579),(619,644),(612,685),
                 (601,734),(596,748)],
    },
    "up_diagonal": {
        "crop": (884, 470, 1215, 748),
        "goggles": [
            [(978,491),(1013,474),(1052,474),(1086,510),
             (1100,540),(1061,568),(1006,562),(966,521)],
            [(1086,474),(1104,476),(1144,491),(1174,522),
             (1188,551),(1170,570),(1120,558),(1097,515)],
        ],
        "lenses": [
            [(992,502),(1020,486),(1051,489),(1070,510),
             (1081,540),(1048,552),(1011,543),(995,527)],
            [(1102,490),(1110,490),(1136,506),(1155,526),
             (1169,542),(1165,550),(1138,540),(1114,515)],
        ],
        "visor": [(993,571),(1100,560),(1167,573),(1185,615),
                  (1189,660),(1098,670),(999,661),(987,618)],
        "ear": (924, 651, 36, 58),
        "far_ear": (1203, 664, 8, 28),
        "seam": [(957,566),(958,630),(970,682),(1081,720),(1203,680),
                 (1199,621),(1186,571),(1048,473)],
        "eyes": [(1063,578,1105,634), (1125,578,1159,635)],
        "axis": [(1076,479),(1097,517),(1101,558),(1108,614),
                 (1104,670),(1081,728)],
    },
}

# These closed contours follow the actual visible rims, rather than treating a
# profile goggle as a compressed frontal landmark cloud. Each row starts at the
# physical top-center and proceeds clockwise through corresponding surfaces.
SIDE_FEATURES = {
    "quarter": {
        "goggle_outer": [
            (786,94),(815,96),(828,111),(838,133),(844,163),(834,189),
            (816,202),(791,209),(766,201),(750,188),(738,171),(728,148),
            (724,127),(740,109),
        ],
        "goggle_inner": [
            (786,111),(810,115),(818,127),(825,148),(830,173),(826,182),
            (811,186),(791,188),(772,186),(760,179),(752,167),(748,150),
            (748,133),(761,120),
        ],
        "visor_outer": [
            (840,185),(883,182),(913,190),(925,213),(926,244),(916,278),
            (896,304),(834,327),(770,318),(701,295),(701,258),(701,220),
            (705,184),(761,170),
        ],
        "visor_inner": [
            (841,207),(880,207),(908,205),(913,224),(913,249),(904,276),
            (887,291),(834,307),(777,298),(730,278),(727,250),(726,221),
            (728,193),(786,191),
        ],
    },
    "side": {
        "goggle_outer": [
            (1367,105),(1390,107),(1410,125),(1427,155),(1439,184),(1449,226),
            (1429,231),(1403,228),(1379,208),(1358,179),(1338,150),(1330,130),
            (1342,116),(1354,109),
        ],
        "goggle_inner": [
            (1386,124),(1396,130),(1404,143),(1415,170),(1424,200),(1427,211),
            (1418,212),(1407,208),(1395,190),(1384,172),(1375,154),(1367,138),
            (1371,131),(1377,127),
        ],
        "visor_outer": [
            (1426,206),(1434,211),(1440,226),(1439,252),(1437,285),(1423,329),
            (1420,346),(1411,364),(1363,351),(1325,329),(1327,286),(1324,242),
            (1326,206),(1384,182),
        ],
        "visor_inner": [
            (1425,229),(1427,229),(1429,236),(1431,260),(1429,290),(1420,327),
            (1416,338),(1413,337),(1384,325),(1349,314),(1346,279),(1346,244),
            (1347,217),(1387,207),
        ],
    },
}


def extract(rgb: np.ndarray, background: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Segment exterior pale matte, retain enclosed highlights, unmatte coverage."""
    delta = np.linalg.norm(rgb - background, axis=2)
    inside = binary_fill_holes(delta > 45)
    components, _ = label(inside)
    counts = np.bincount(components.ravel())
    counts[0] = 0
    inside = components == counts.argmax()
    solid = binary_erosion(inside, iterations=2)
    _, nearest = distance_transform_edt(~solid, return_indices=True)
    direction = rgb[nearest[0], nearest[1]] - background
    alpha = np.clip(
        np.sum((rgb - background) * direction, axis=2)
        / np.maximum(np.sum(direction * direction, axis=2), 1), 0, 1,
    )
    alpha[solid] = 1
    alpha[(delta < 3) & ~inside] = 0
    clean = np.clip(
        (rgb - background * (1 - alpha[..., None]))
        / np.maximum(alpha[..., None], 0.001), 0, 255,
    )
    return clean, alpha


def remove_eye(rgb: np.ndarray, roi: tuple, origin: np.ndarray, profile=False):
    x0, y0, x1, y1 = np.asarray(roi) - np.tile(origin, 2)
    patch = rgb[y0:y1, x0:x1]
    core = ((patch[..., 1] > 155) & (patch[..., 2] > 200)
            & (patch[..., 1] - patch[..., 0] > 23))
    ys, xs = np.nonzero(core)
    if len(xs) < 20:
        raise ValueError(f"Eye not found in {roi}")
    points = np.column_stack((xs + x0, ys + y0))
    center = (points.min(axis=0) + points.max(axis=0)) / 2
    covariance = np.cov(points.T)
    values, vectors = np.linalg.eigh(covariance)
    vertical = vectors[:, values.argmax()]
    if vertical[1] < 0:
        vertical *= -1
    horizontal = np.array([vertical[1], -vertical[0]])
    projected = (points - center) @ np.column_stack((horizontal, vertical))
    radii = np.ptp(projected, axis=0) / 2 + 0.5
    # A padded region removes cyan bloom as well as the scanline-shaped core.
    pad_x, pad_y = (3, 5) if profile else (5, 5)
    lo = points.min(axis=0) - (pad_x, pad_y)
    hi = points.max(axis=0) + (pad_x, pad_y) + 1
    mask = np.zeros(rgb.shape[:2], dtype=bool)
    mask[lo[1]:hi[1], lo[0]:hi[0]] = True
    harmonic_fill(rgb, mask)
    return center + origin, horizontal * radii[0], vertical * radii[1]


def harmonic_fill(rgb: np.ndarray, mask: np.ndarray):
    ys, xs = np.nonzero(mask)
    ids = np.full(mask.shape, -1, dtype=np.int32)
    ids[ys, xs] = np.arange(len(xs))
    matrix = lil_matrix((len(xs), len(xs)))
    rhs = np.zeros((len(xs), 3))
    for i, (y, x) in enumerate(zip(ys, xs)):
        matrix[i, i] = 4
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            j = ids[y + dy, x + dx]
            if j >= 0:
                matrix[i, j] = -1
            else:
                rhs[i] += rgb[y + dy, x + dx]
    rgb[ys, xs] = spsolve(matrix.tocsr(), rhs)


def normalize(points, crop):
    center = (np.asarray(crop[:2]) + np.asarray(crop[2:])) / 2
    return (np.asarray(points, dtype=float) - center) * SCALE + (WIDTH / 2, HEIGHT / 2)


def radial_outline(alpha, count=40):
    """Shared angular correspondence makes both warped silhouettes coincide."""
    points = []
    center = np.array([WIDTH / 2, HEIGHT / 2])
    for angle in np.linspace(-math.pi / 2, 3 * math.pi / 2, count, endpoint=False):
        ray = center + np.arange(1, 220, 0.25)[:, None] * (math.cos(angle), math.sin(angle))
        samples = map_coordinates(alpha, [ray[:, 1], ray[:, 0]], order=1, mode="constant")
        hits = np.flatnonzero(samples > 0.5)
        points.append(ray[hits[-1]] if len(hits) else center)
    return np.array(points)


def make_pose(name, source, output):
    spec = SOURCE[name]
    crop = spec["crop"]
    origin = np.array(crop[:2])
    rgb, alpha = extract(np.asarray(source.crop(crop), dtype=float),
                         np.asarray(source)[0, 0].astype(float))
    eyes = []
    eye_points = []
    for index, roi in enumerate(spec["eyes"]):
        if roi is None:
            center = np.array([1428., 273.])
            u, v = np.array([0.65, 0.]), np.array([0., 18.])
            visibility = 0.
        else:
            center, u, v = remove_eye(rgb, roi, origin, name == "side")
            visibility = 1.
        center = normalize(center, crop)
        u, v = u * SCALE, v * SCALE
        eye_points.extend([center, center + u, center + v, center - u, center - v])
        eyes.append({"visibility": visibility})
    rgba = np.dstack((rgb, alpha * 255)).round().astype(np.uint8)
    normalized = Image.new("RGBA", (WIDTH, HEIGHT))
    size = tuple(round(d * SCALE) for d in (crop[2] - crop[0], crop[3] - crop[1]))
    resized = Image.fromarray(rgba).resize(size, Image.Resampling.LANCZOS)
    normalized.paste(resized, ((WIDTH - size[0]) // 2, (HEIGHT - size[1]) // 2))
    arr = np.asarray(normalized).astype(float)
    arr[..., :3] *= arr[..., 3:] / 255
    normalized.save(output / f"{name}-clean.png")
    features = []
    names = []
    for family in ("goggles", "lenses"):
        for eye, contour in enumerate(spec[family]):
            features.extend(normalize(contour, crop))
            names.extend(f"{family}{eye}_{i}" for i in range(8))
    features.extend(normalize(spec["visor"], crop))
    names.extend(f"visor{i}" for i in range(8))
    cx, cy, rx, ry = spec["ear"]
    ear = [(cx + rx * math.cos(a), cy + ry * math.sin(a))
           for a in np.linspace(-math.pi / 2, 3 * math.pi / 2, 8, endpoint=False)]
    features.extend(normalize(ear, crop))
    names.extend(f"ear{i}" for i in range(8))
    features.extend(normalize(spec["seam"], crop))
    names.extend(f"seam{i}" for i in range(8))
    features.extend(normalize(spec["axis"], crop))
    names.extend(f"axis{i}" for i in range(6))
    eye_start = len(features)
    features.extend(eye_points)
    names.extend(f"eye{i}_{j}" for i in range(2) for j in range(5))
    outline_start = len(features)
    features.extend(radial_outline(arr[..., 3] / 255))
    names.extend(f"outline{i}" for i in range(40))
    features.extend([(0,0),(WIDTH-1,0),(WIDTH-1,HEIGHT-1),(0,HEIGHT-1)])
    names.extend(f"canvas{i}" for i in range(4))
    pose = {
        "name": name, "image": arr, "points": np.asarray(features),
        "eyes": eyes, "eye_start": eye_start, "outline_start": outline_start,
        "names": names,
    }
    return pose


YY, XX = np.mgrid[:HEIGHT, :WIDTH]
POLAR_ANGLE = np.arctan2(YY - HEIGHT / 2, XX - WIDTH / 2)
POLAR_RADIUS = np.hypot(YY - HEIGHT / 2, XX - WIDTH / 2)
_noise = np.random.default_rng(7).normal(size=(64, 64))
_noise -= gaussian_filter(_noise, 1., mode="wrap")
_noise = np.argsort(np.argsort(_noise.ravel())).reshape(64, 64) / 4095 - 0.5
QUANTIZATION_NOISE = np.tile(_noise, (5, 6))[:HEIGHT, :WIDTH]


def triangle_area(points, triangles):
    p = points[triangles]
    a, b = p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]
    return a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]


MESH_CACHE = {}
FLOW_CACHE = {}
FEATURE_CACHE = {}


def stable_mesh(a, b, candidates=None):
    """Keep a common Delaunay topology; discard occluded/conflicting anchors.

    Radial silhouette points are not anatomical correspondences: a ray can hit
    an ear in one view and a lens in another. They must not cut across the
    stronger goggle/visor correspondences. Likewise, a hidden profile feature
    cannot keep a meaningful mesh area. Pruning those anchors prevents folds.
    """
    if candidates is None:
        candidates = np.r_[0:56, 62, 67, 72:112:5, 112:116]
    indices = np.asarray(candidates)
    confidence = np.ones(len(a)) * 0.3
    confidence[:32] = 8
    confidence[32:40] = 5
    confidence[40:48] = 2
    confidence[48:56] = 2
    confidence[[62, 67]] = 20
    confidence[-4:] = 1e9
    states = [a * (1-t) + b*t for t in np.linspace(0, 1, 9)]

    def invalid(triangles):
        return np.any([triangle_area(p, triangles) <= 0.01 for p in states], axis=0)

    while True:
        midpoint = (a + b) / 2
        triangles = indices[Delaunay(midpoint[indices]).simplices]
        # Legalize ambiguous diagonals before sacrificing measured features.
        while True:
            bad = invalid(triangles)
            if not bad.any():
                return triangles
            adjacency = {}
            for i, triangle in enumerate(triangles):
                for j in range(3):
                    edge = tuple(sorted((triangle[j], triangle[(j+1) % 3])))
                    adjacency.setdefault(edge, []).append(i)
            changed = False
            for edge, neighbors in adjacency.items():
                if len(neighbors) != 2 or not bad[neighbors].any():
                    continue
                one, two = neighbors
                c = next(p for p in triangles[one] if p not in edge)
                d = next(p for p in triangles[two] if p not in edge)
                replacement = np.array([[c, d, edge[0]], [d, c, edge[1]]])
                # A valid edge flip keeps both triangles' winding unchanged.
                if triangle_area(midpoint, replacement).max() < 0:
                    replacement = replacement[:, [1,0,2]]
                if not invalid(replacement).any():
                    triangles[neighbors] = replacement
                    changed = True
                    break
            if not changed:
                break
        if not bad.any():
            return triangles
        incidence = np.bincount(triangles[bad].ravel(), minlength=len(a))
        remove = np.argmax(incidence / confidence)
        indices = indices[indices != remove]
        if len(indices) < 12:
            raise ValueError("Insufficient non-folding landmark correspondence")


def coordinate_map(source_points, target_points, triangles):
    source = np.zeros((HEIGHT, WIDTH, 2))
    for triangle in triangles:
        dst = target_points[triangle]
        lo = np.maximum(np.floor(dst.min(axis=0)).astype(int), (0, 0))
        hi = np.minimum(np.ceil(dst.max(axis=0)).astype(int), (WIDTH-1, HEIGHT-1))
        y, x = np.mgrid[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
        pixels = np.stack((x, y), axis=-1)
        basis = np.column_stack((dst[0] - dst[2], dst[1] - dst[2]))
        uv = (pixels - dst[2]) @ np.linalg.inv(basis).T
        weights = np.dstack((uv, 1 - uv.sum(axis=-1)))
        inside = np.all(weights >= -1e-7, axis=-1)
        mapped = weights @ source_points[triangle]
        region = source[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
        region[inside] = mapped[inside]
    # Smooth derivative discontinuities across long shell triangles, without
    # blurring the source artwork itself.
    return gaussian_filter(source, (3, 3, 0)).reshape(-1, 2)


def warp(image, source_points, target_points, triangulation=None):
    triangles = (stable_mesh(source_points, target_points)
                 if triangulation is None else triangulation)
    source = coordinate_map(source_points, target_points, triangles)
    channels = [map_coordinates(image[..., i], [source[:, 1], source[:, 0]],
                                order=1, mode="constant").reshape(HEIGHT, WIDTH)
                for i in range(4)]
    return np.stack(channels, axis=2)


def symmetric_pose(pose, name):
    """Frontalize the near half, including its real dome or underside texture."""
    points = pose["points"].copy()
    target = points.copy()
    # Symmetric contour correspondence reverses the winding of the far goggle.
    reverse = [2, 1, 0, 7, 6, 5, 4, 3]
    axis = WIDTH / 2
    # Preserve the near goggle's rendered vertical tilt, then level paired sides.
    # The goggle bridge is a more stable yaw center than the head bounding box.
    source_axis = points[[55,56,57,58,59,60,61], 0]
    source_y = points[[55,56,57,58,59,60,61], 1]
    order = np.argsort(source_y)

    def axis_at(y):
        return np.interp(y, source_y[order], source_axis[order])

    for i in range(len(points) - 4):
        target[i, 0] = axis + (points[i, 0] - axis_at(points[i, 1]))
    for start in (0, 16):
        for j in range(8):
            near = start + j
            far = start + 8 + reverse[j]
            target[far] = (WIDTH - target[near, 0], target[near, 1])
    # Visor corners and shell frame use matching left/right perimeter positions.
    for left, right in ((32,34),(39,35),(38,36),(48,54),(49,53),(50,52)):
        target[right] = (WIDTH - target[left, 0], target[left, 1])
    for i in (33,37,51,55,56,57,58,59,60,61):
        target[i, 0] = axis
    eye_start = pose["eye_start"]
    for j, reflected in enumerate((0, 3, 2, 1, 4)):
        target[eye_start + 5 + j] = (
            WIDTH - target[eye_start + reflected, 0], target[eye_start + reflected, 1]
        )
    # Fit the frontalized half without allowing its wider rear shell to clip.
    near_outline = target[pose["outline_start"]:pose["outline_start"]+40]
    left_extent = axis - near_outline[:, 0].min()
    factor = min(1., 155. / left_extent)
    target[:-4, 0] = axis + (target[:-4, 0] - axis) * factor
    # Only the near half supplies texture; far-side targets are geometry for
    # subsequent animation, not competing constraints during frontalization.
    candidates = np.r_[0:8, 16:24, 32,33,37:40,40:52,55:63,72:112:5,112:116]
    mesh = stable_mesh(points, target, candidates)
    warped = warp(pose["image"], points, target, mesh)
    warped[:, WIDTH // 2:] = warped[:, :WIDTH // 2][:, ::-1]
    # Restore exact paired landmarks after the mirrored texture operation.
    target[pose["outline_start"]:pose["outline_start"]+40] = radial_outline(
        warped[..., 3] / 255)
    target[-4:] = points[-4:]
    result = dict(pose, name=name, image=warped, points=target,
                  eyes=[{"visibility": 1.}, {"visibility": 1.}])
    return result


def mirrored_destination(pose, name):
    """Reflect a destination, retaining the shared front's landmark semantics.

    Reflecting already-rendered nonzero frames also reflects the neutral
    artwork's asymmetric lighting. Instead, swap paired destination features
    and their winding so an ordinary morph starts at the real shared front.
    """
    original = pose["points"]
    points = original.copy()
    reverse = np.array([2, 1, 0, 7, 6, 5, 4, 3])
    for start in (0, 16):
        points[start:start+8] = original[start+8+reverse]
        points[start+8:start+16] = original[start+reverse]
    points[32:40] = original[32+reverse]
    points[48:56] = original[48+np.array([6, 5, 4, 3, 2, 1, 0, 7])]
    cx, cy, rx, ry = SOURCE[pose["name"]]["far_ear"]
    angles = np.linspace(-math.pi/2, 3*math.pi/2, 8, endpoint=False)
    far_ear = np.column_stack((cx + rx*np.cos(angles), cy + ry*np.sin(angles)))
    points[40:48] = normalize(far_ear[(-np.arange(8)) % 8], SOURCE[pose["name"]]["crop"])
    eye_start = pose["eye_start"]
    eye_reverse = np.array([0, 3, 2, 1, 4])
    points[eye_start:eye_start+5] = original[eye_start+5+eye_reverse]
    points[eye_start+5:eye_start+10] = original[eye_start+eye_reverse]
    points[:, 0] = WIDTH - 1 - points[:, 0]
    image = pose["image"][:, ::-1].copy()
    start = pose["outline_start"]
    points[start:start+40] = radial_outline(image[..., 3] / 255)
    points[-4:] = original[-4:]
    return dict(pose, name=name, reference_name=pose["name"], image=image,
                points=points, eyes=[dict(eye) for eye in reversed(pose["eyes"])])


def geometry(points, pose, visibility):
    eyes = []
    for i in range(2):
        p = points[pose["eye_start"] + i * 5:pose["eye_start"] + i * 5 + 5]
        u, v = (p[1] - p[3]) / 2, (p[2] - p[4]) / 2
        eyes.append({
            "x": round(float(p[0, 0]), 4), "y": round(float(p[0, 1]), 4),
            "rx": round(max(0.2, float(np.linalg.norm(u))), 4),
            "ry": round(max(0.2, float(np.linalg.norm(v))), 4),
            "angle": round(float(math.atan2(u[1], u[0])), 6),
            "visibility": round(float(visibility[i]), 5),
        })
    return eyes


def residual_registration(first, second):
    """Regularized subpixel registration refines the curved landmark edges.

    Piecewise-affine landmarks describe polygonal approximations to the rims.
    A bounded, smooth residual field aligns their curved highlights rather than
    crossfading two slightly offset outlines. It cannot invent a new view.
    """
    flow = None
    for scale in (0.25, 0.5, 1.):
        a = zoom(first[..., :3], (scale, scale, 1), order=1)
        b = zoom(second[..., :3], (scale, scale, 1), order=1)
        a = gaussian_filter(a, (0.7, 0.7, 0))
        b = gaussian_filter(b, (0.7, 0.7, 0))
        h, w = a.shape[:2]
        yy, xx = np.mgrid[:h, :w]
        if flow is None:
            flow = np.zeros((h, w, 2))
        else:
            flow = zoom(flow, (2, 2, 1), order=1) * 2
        gy, gx = np.gradient(b, axis=(0, 1))
        for _ in range(65):
            coords = [yy + flow[..., 1], xx + flow[..., 0]]
            warped = np.stack([map_coordinates(b[..., c], coords, order=1, mode="nearest")
                               for c in range(3)], axis=-1)
            grad_x = np.stack([map_coordinates(gx[..., c], coords, order=1, mode="nearest")
                               for c in range(3)], axis=-1)
            grad_y = np.stack([map_coordinates(gy[..., c], coords, order=1, mode="nearest")
                               for c in range(3)], axis=-1)
            residual = a - warped
            denominator = (np.sum(grad_x**2 + grad_y**2, axis=-1)
                           + np.sum(residual**2, axis=-1) * 0.08 + 50)
            update = np.stack((np.sum(residual * grad_x, axis=-1),
                               np.sum(residual * grad_y, axis=-1)), axis=-1)
            update /= denominator[..., None]
            update /= np.maximum(1, np.linalg.norm(update, axis=-1, keepdims=True) / 0.65)
            flow = gaussian_filter(flow + update, (1.1, 1.1, 0))
            flow /= np.maximum(1, np.linalg.norm(flow, axis=-1, keepdims=True) / (12 * scale))
    return gaussian_filter(flow, (2.4, 2.4, 0))


def flow_warp(image, flow, amount):
    coordinates = [YY + flow[..., 1] * amount, XX + flow[..., 0] * amount]
    return np.stack([map_coordinates(image[..., c], coordinates, order=1, mode="constant")
                     for c in range(4)], axis=-1)


def dense_contour(points, count=112):
    p = np.asarray(points, dtype=float)
    # Shape-preserving interpolation avoids tiny loops where a profile rim
    # becomes almost edge-on and adjacent measured points are very close.
    wrapped = np.vstack((p[-2:], p, p[:3]))
    spline = PchipInterpolator(np.arange(-2, len(p)+3), wrapped)
    return spline(np.linspace(0, len(p), count, endpoint=False))


def contour_mask(contour, antialias=1):
    image = Image.new("L", (WIDTH * antialias, HEIGHT * antialias))
    ImageDraw.Draw(image).polygon(
        [tuple(p * antialias) for p in contour], fill=255)
    if antialias != 1:
        image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    return np.asarray(image, dtype=float) / 255


def prepare_side_features(a, b):
    features = {}
    for pose in (a, b):
        name = pose["name"]
        spec = SIDE_FEATURES[name]
        contours = {key: dense_contour(normalize(value, SOURCE[name]["crop"]))
                    for key, value in spec.items()}
        contours["far_outer"] = dense_contour(normalize(
            SOURCE[name]["goggles"][1], SOURCE[name]["crop"]))
        contours["far_inner"] = dense_contour(normalize(
            SOURCE[name]["lenses"][1], SOURCE[name]["crop"]))
        goggle_mask = contour_mask(contours["goggle_outer"]) > 0
        if name == "quarter":
            goggle_mask |= contour_mask(contours["far_outer"]) > 0
        goggle_mask = binary_dilation(goggle_mask, iterations=3)
        original = pose["image"].copy()
        alpha = original[..., 3:] / 255
        original[..., :3] /= np.maximum(alpha, 0.001)
        opaque = alpha[..., 0] > 0.5
        _, nearest = distance_transform_edt(~opaque, return_indices=True)
        original[..., :3][~opaque] = original[..., :3][nearest[0][~opaque], nearest[1][~opaque]]
        # The small polygonal approximation must not sample black background
        # into a pale rim; extend its nearest genuine foreground color instead.
        original[..., 3] = 255
        visor_source = original.copy()
        harmonic_fill(visor_source[..., :3], goggle_mask)
        base_mask = goggle_mask | (contour_mask(contours["visor_outer"]) > 0)
        base_mask = binary_dilation(base_mask, iterations=2)
        base = original.copy()
        harmonic_fill(base[..., :3], base_mask)
        base[..., :3] *= alpha
        base[..., 3:] = alpha * 255
        features[name] = dict(contours=contours, original=original,
                              visor=visor_source, base=base)
    return features


def feature_coordinates(outer, inner):
    return np.vstack((inner.mean(axis=0), inner, outer))


def feature_triangles(count):
    triangles = []
    for i in range(count):
        j = (i+1) % count
        triangles.extend(((0, 1+i, 1+j),
                          (1+i, 1+count+i, 1+count+j),
                          (1+i, 1+count+j, 1+j)))
    return np.asarray(triangles)


def render_feature(image, source_outer, source_inner, target_outer, target_inner):
    """A separate dense mesh keeps each lens and rim a single closed surface."""
    source_points = feature_coordinates(source_outer, source_inner)
    target_points = feature_coordinates(target_outer, target_inner)
    triangles = feature_triangles(len(source_outer))
    mapping = np.zeros((HEIGHT, WIDTH, 2))
    valid = np.zeros((HEIGHT, WIDTH), dtype=bool)
    for triangle in triangles:
        dst = target_points[triangle]
        lo = np.maximum(np.floor(dst.min(axis=0)).astype(int), (0, 0))
        hi = np.minimum(np.ceil(dst.max(axis=0)).astype(int), (WIDTH-1, HEIGHT-1))
        if np.any(hi < lo):
            continue
        basis = np.column_stack((dst[0] - dst[2], dst[1] - dst[2]))
        if abs(np.linalg.det(basis)) < 1e-7:
            continue
        y, x = np.mgrid[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
        uv = (np.stack((x, y), axis=-1) - dst[2]) @ np.linalg.inv(basis).T
        weights = np.dstack((uv, 1-uv.sum(axis=-1)))
        inside = np.all(weights >= -1e-7, axis=-1)
        region = mapping[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
        region[inside] = (weights @ source_points[triangle])[inside]
        valid[lo[1]:hi[1]+1, lo[0]:hi[0]+1] |= inside
    _, nearest = distance_transform_edt(~valid, return_indices=True)
    mapping[~valid] = mapping[nearest[0][~valid], nearest[1][~valid]]
    rgb = np.stack([
        map_coordinates(image[..., c], [mapping[..., 1], mapping[..., 0]],
                        order=1, mode="nearest") for c in range(3)
    ], axis=-1)
    coverage = contour_mask(target_outer, antialias=3)
    return np.dstack((rgb * coverage[..., None], coverage * 255))


def overlay(base, layer):
    alpha = layer[..., 3:] / 255
    return layer + base * (1-alpha)


def side_feature_layers(base, features, amount):
    a, b = features["quarter"], features["side"]
    ca, cb = a["contours"], b["contours"]
    for feature in ("visor", "goggle"):
        outer = ca[f"{feature}_outer"] * (1-amount) + cb[f"{feature}_outer"] * amount
        inner = ca[f"{feature}_inner"] * (1-amount) + cb[f"{feature}_inner"] * amount
        source = "original" if feature == "goggle" else "visor"
        first = render_feature(a[source], ca[f"{feature}_outer"], ca[f"{feature}_inner"],
                               outer, inner)
        second = render_feature(b[source], cb[f"{feature}_outer"], cb[f"{feature}_inner"],
                                outer, inner)
        # Both images now share exactly the same inner and outer boundary.
        layer = first * (1-amount) + second * amount
        if feature == "goggle":
            # The far eyepiece moves *behind* the near one. It is not blended
            # into the near lens or stretched into its front-facing rim.
            far_center = normalize((1433, 204), SOURCE["side"]["crop"])
            endpoint_outer = far_center + (ca["far_outer"] - ca["far_outer"].mean(axis=0)) * (0.015, 0.5)
            endpoint_inner = far_center + (ca["far_inner"] - ca["far_inner"].mean(axis=0)) * (0.015, 0.5)
            far_outer = ca["far_outer"] * (1-amount) + endpoint_outer * amount
            far_inner = ca["far_inner"] * (1-amount) + endpoint_inner * amount
            far = render_feature(a["original"], ca["far_outer"], ca["far_inner"],
                                 far_outer, far_inner)
            far *= 1 - max(0., (amount-0.6) / 0.4)
            base = overlay(base, far)
        base = overlay(base, layer)
    return base


def morph(a, b, amount):
    if amount <= 0:
        return a["image"], geometry(a["points"], a,
                                   [e["visibility"] for e in a["eyes"]])
    if amount >= 1:
        return b["image"], geometry(b["points"], b,
                                   [e["visibility"] for e in b["eyes"]])
    points = a["points"] * (1 - amount) + b["points"] * amount
    key = (a["name"], b["name"])
    if key not in MESH_CACHE:
        MESH_CACHE[key] = stable_mesh(a["points"], b["points"])
        print(f"  {key}: {len(np.unique(MESH_CACHE[key]))} non-folding anchors", flush=True)
    mesh = MESH_CACHE[key]
    side = b["name"] == "side"
    if side and key not in FEATURE_CACHE:
        FEATURE_CACHE[key] = prepare_side_features(a, b)
    image_a = FEATURE_CACHE[key]["quarter"]["base"] if side else a["image"]
    image_b = FEATURE_CACHE[key]["side"]["base"] if side else b["image"]
    first = warp(image_a, a["points"], points, mesh)
    second = warp(image_b, b["points"], points, mesh)
    if key not in FLOW_CACHE:
        midpoint = (a["points"] + b["points"]) / 2
        reference_a = warp(a["image"], a["points"], midpoint, mesh)
        reference_b = warp(b["image"], b["points"], midpoint, mesh)
        FLOW_CACHE[key] = residual_registration(reference_a, reference_b)
    flow = FLOW_CACHE[key]
    first = flow_warp(first, flow, -amount)
    second = flow_warp(second, flow, 1 - amount)
    visibility = [a["eyes"][i]["visibility"] * (1 - amount)
                  + b["eyes"][i]["visibility"] * amount for i in range(2)]
    # Extend foreground texture across narrow coverage disagreements instead
    # of blending transparent black into the single interpolated silhouette.
    colors = []
    for warped in (first, second):
        alpha = np.clip(warped[..., 3] / 255, 0, 1)
        mask = alpha > 0.5
        _, nearest = distance_transform_edt(~mask, return_indices=True)
        rgb = warped[..., :3] / np.maximum(alpha[..., None], 0.001)
        rgb[~mask] = rgb[nearest[0][~mask], nearest[1][~mask]]
        colors.append(rgb)
    # Silhouette correspondence is independent of the internal texture mesh.
    # This prevents a small visible scalp strip from making angular dents when
    # it expands into the profile's much larger dome.
    outline = points[a["outline_start"]:a["outline_start"] + 40]
    radii = np.linalg.norm(outline - (WIDTH / 2, HEIGHT / 2), axis=1)
    angles = np.linspace(-math.pi / 2, 3 * math.pi / 2, 41)
    contour = CubicSpline(angles, np.r_[radii, radii[0]], bc_type="periodic")
    pixel_angles = (POLAR_ANGLE + math.pi / 2) % (2 * math.pi) - math.pi / 2
    coverage = np.clip(contour(pixel_angles) - POLAR_RADIUS + 0.5, 0, 1)
    texture_amount = amount
    if b.get("reference_name", b["name"]) != "quarter":
        # Disoccluded surfaces must come from the deeper reference, not from
        # an enlarged sliver of front-view shell. Bring that texture in early;
        # geometry still follows the full, uniformly sampled landmark track.
        texture_amount = min(1., amount / (0.65 if b["name"] == "side" else 0.8))
        texture_amount = texture_amount**2 * (3 - 2 * texture_amount)
    color = colors[0] * (1 - texture_amount) + colors[1] * texture_amount
    image = np.dstack((color * coverage[..., None], coverage * 255))
    if side:
        image = side_feature_layers(image, FEATURE_CACHE[key], amount)
    return image, geometry(points, a, visibility)


def mirrored(image, eyes):
    reflected = []
    for eye in reversed(eyes):
        eye = dict(eye)
        eye["x"] = WIDTH - 1 - eye["x"]
        eye["angle"] = -eye["angle"]
        reflected.append(eye)
    return image[:, ::-1].copy(), reflected


def quantize(image):
    rgb = Image.fromarray(np.clip(image[..., :3], 0, 255).round().astype(np.uint8))
    # A per-frame adaptive palette keeps the low-key blue gradients intact.
    # Full error diffusion introduces bright stipple in the blue gradients.
    # Bounded, neutral blue-noise dither softens RGB565 bands without allowing
    # accumulated diffusion error to select conspicuously different colors.
    adaptive = rgb.quantize(colors=256, method=Image.Quantize.MEDIANCUT,
                            dither=Image.Dither.NONE)
    palette = np.asarray(adaptive.getpalette(), dtype=np.uint8).reshape(-1, 3)
    rgb565 = (((palette[:, 0].astype(np.uint16) >> 3) << 11)
              | ((palette[:, 1].astype(np.uint16) >> 2) << 5)
              | (palette[:, 2].astype(np.uint16) >> 3))
    actual = np.column_stack((((rgb565 >> 11) * 255 + 15) // 31,
                              (((rgb565 >> 5) & 63) * 255 + 31) // 63,
                              ((rgb565 & 31) * 255 + 15) // 31)).astype(np.uint8)
    pal_image = Image.new("P", (1, 1))
    pal_image.putpalette(actual.ravel().tolist())
    colors = np.asarray(rgb).astype(float)
    perturbed = colors + QUANTIZATION_NOISE[..., None] * 6
    perturbed[~np.any(colors, axis=-1)] = 0
    input_image = Image.fromarray(np.clip(perturbed, 0, 255).round().astype(np.uint8))
    indexed = input_image.quantize(palette=pal_image, dither=Image.Dither.NONE)
    record = rgb565.astype("<u2").tobytes() + zlib.compress(indexed.tobytes(), level=9)
    return record, indexed.convert("RGB")


def draw_eyes(image, eyes):
    arr = np.asarray(image).astype(float).copy()
    for eye in eyes:
        if eye["visibility"] <= 0:
            continue
        angle = eye["angle"]
        dx, dy = XX - eye["x"], YY - eye["y"]
        x = (dx * math.cos(angle) + dy * math.sin(angle)) / eye["rx"]
        y = (-dx * math.sin(angle) + dy * math.cos(angle)) / eye["ry"]
        # Rounded scanline capsules resemble the originals better than ovals.
        boundary = x * x + np.maximum(np.abs(y) - 0.52, 0) ** 2 / 0.48 ** 2
        coverage = np.clip((1 - boundary) * min(eye["rx"], eye["ry"]), 0, 1)
        coverage *= eye["visibility"]
        scanline = 0.75 + 0.25 * np.cos((y * eye["ry"]) * math.pi)
        color = np.zeros_like(arr)
        color[:] = (85, 222, 255)
        color *= scanline[..., None]
        arr = arr * (1 - coverage[..., None]) + color * coverage[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def save_landmarks(pose, output):
    image = Image.fromarray(np.clip(pose["image"][..., :3], 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    for i, point in enumerate(pose["points"][:-4]):
        x, y = point
        draw.ellipse((x-1, y-1, x+1, y+1), fill=(255, 240, 70))
        draw.text((x+2, y-4), str(i), fill=(255, 240, 70), font_size=9)
    image.save(output / f"{pose['name']}-landmarks.png")
    (output / f"{pose['name']}-landmarks.json").write_text(json.dumps({
        "names": pose["names"], "points": pose["points"].round(4).tolist(),
        "eyes": geometry(pose["points"], pose, [e["visibility"] for e in pose["eyes"]]),
    }, indent=2) + "\n")


def write_metadata(frames, blob, source):
    document = {
        "width": WIDTH, "height": HEIGHT, "steps": STEPS,
        "directions": list(DIRECTIONS), "frames": frames,
        "source": "copilot-source.png",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "method": ("Five rendered references, harmonic eye inpainting, non-folding "
                   "Delaunay landmark morphs, bounded residual edge registration, "
                   "112-point closed side-rim meshes with ordered goggle occlusion"),
        "limitations": ("Approximate view interpolation, not reconstructed 3D. "
                        "Vertical views mirror the visible reference half; "
                        "some intermediate highlights and occlusion transitions "
                        "remain approximate."),
        "left_track_construction": (
            "Actual shared front to semantically mirrored destination landmarks; "
            "deep side segment mirrors the existing coherent occlusion meshes."
        ),
        "record_format": "512-byte RGB565-LE palette + zlib-compressed uint8 indices",
        "eye_angle_convention": "radians; positive rotation from +x toward +y",
        "byte_length": len(blob),
    }
    (ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.json").write_text(json.dumps(document, indent=2) + "\n")
    header = """// Generated by characters/copilot/legacy-atlas/tools/prepare_turn_atlas.py; do not edit.
#pragma once
#include <cstdint>
namespace copilot {
constexpr int kAtlasWidth = 336;
constexpr int kAtlasHeight = 304;
constexpr int kAtlasSteps = 33;
constexpr int kAtlasDirections = 8;
constexpr int kAtlasFrameCount = 264;
struct AtlasEye { float x, y, rx, ry, angle, visibility; };
struct AtlasFrame { uint32_t offset, size; AtlasEye eyes[2]; };
extern const AtlasFrame kAtlasFrames[kAtlasFrameCount];
extern const uint8_t kAtlasData[];
extern const uint32_t kAtlasDataSize;
}
"""
    (ROOT / "characters/copilot/legacy-atlas/generated/turn_atlas.h").write_text(header)
    with (ROOT / "characters/copilot/legacy-atlas/src/turn_atlas.cpp").open("w") as stream:
        stream.write('// Generated by characters/copilot/legacy-atlas/tools/prepare_turn_atlas.py; do not edit.\n'
                     '#include "../generated/turn_atlas.h"\nnamespace copilot {\n'
                     'const AtlasFrame kAtlasFrames[kAtlasFrameCount] = {\n')
        for frame in frames:
            eyes = []
            for eye in frame["eyes"]:
                eyes.append("{" + ", ".join(
                    f"{eye[key]:.6f}f" for key in ("x","y","rx","ry","angle","visibility")
                ) + "}")
            stream.write(f'  {{{frame["offset"]}u, {frame["size"]}u, '
                         + "{" + ", ".join(eyes) + "}},\n")
        stream.write(f"}};\nconst uint32_t kAtlasDataSize = {len(blob)}u;\n}}\n")


def main():
    source_path = ROOT / "characters/copilot/source/copilot-source.png"
    source = Image.open(source_path).convert("RGB")
    if source.size != (1600, 844):
        raise ValueError("Expected the original 1600 × 844 reference sheet.")
    output = ROOT / "characters/copilot/legacy-atlas/assets/turns"
    output.mkdir(parents=True, exist_ok=True)
    preview = ROOT / "preview"
    preview.mkdir(exist_ok=True)
    poses = {name: make_pose(name, source, output) for name in SOURCE}
    poses["up"] = symmetric_pose(poses["up_diagonal"], "up")
    poses["down"] = symmetric_pose(poses["down_diagonal"], "down")
    for source_name, name in (("quarter", "quarter_left"),
                              ("up_diagonal", "up_left"),
                              ("down_diagonal", "down_left")):
        poses[name] = mirrored_destination(poses[source_name], name)
    for pose in poses.values():
        save_landmarks(pose, output)
        Image.fromarray(np.clip(pose["image"], 0, 255).astype(np.uint8)).save(
            output / f"{pose['name']}-premultiplied.png")
    blob = bytearray()
    records = {}
    frames = []
    pictures = {}
    for direction in DIRECTIONS:
        print(f"Generating {direction}...", flush=True)
        for step in range(STEPS):
            t = step / (STEPS - 1)
            if direction in ("right", "left"):
                if t <= 0.5:
                    endpoint = "quarter_left" if direction == "left" else "quarter"
                    image, eyes = morph(poses["front"], poses[endpoint], t * 2)
                else:
                    image, eyes = morph(poses["quarter"], poses["side"], t * 2 - 1)
                    if direction == "left":
                        image, eyes = mirrored(image, eyes)
            else:
                endpoint = direction.replace("_right", "_diagonal")
                image, eyes = morph(poses["front"], poses[endpoint], t)
            record, decoded = quantize(image)
            digest = hashlib.sha256(record).digest()
            if digest not in records:
                records[digest] = (len(blob), len(record))
                blob.extend(record)
            offset, size = records[digest]
            frames.append({"offset": offset, "size": size, "eyes": eyes})
            pictures[(direction, step)] = draw_eyes(decoded, eyes)
    if len(blob) > 10 * 1024 * 1024:
        raise ValueError(f"Atlas exceeds 10 MiB: {len(blob):,} bytes")
    (ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.bin").write_bytes(blob)
    write_metadata(frames, blob, source_path)
    selections = [
        [("left",32),("left",24),("left",16),("left",8),("right",0),
         ("right",8),("right",16),("right",24),("right",32)],
        [("up",32),("up",24),("up",16),("up",8),("right",0),
         ("down",8),("down",16),("down",24),("down",32)],
        [("up_left",32),("up_left",16),("up_right",16),("up_right",32),("right",0),
         ("down_left",32),("down_left",16),("down_right",16),("down_right",32)],
    ]
    sheet = Image.new("RGB", (WIDTH * 9, (HEIGHT + 30) * 3), (16, 19, 29))
    draw = ImageDraw.Draw(sheet)
    for row, selections_row in enumerate(selections):
        for col, key in enumerate(selections_row):
            x, y = col * WIDTH, row * (HEIGHT + 30)
            sheet.paste(pictures[key], (x, y))
            draw.text((x+12, y+HEIGHT+6), f"{key[0]}  {key[1]}/32", fill="white")
    sheet.save(preview / "turn-contact-sheet.png")
    animation = []
    durations = []
    for direction in DIRECTIONS:
        for step in list(range(STEPS)) + list(range(STEPS - 2, -1, -1)):
            frame = pictures[(direction, step)].copy()
            ImageDraw.Draw(frame).text((10, 8), direction.replace("_", " "), fill=(180, 194, 216))
            animation.append(frame)
            durations.append(360 if step in (0, 32) else 35)
    animation[0].save(preview / "turn-directions.webp", save_all=True,
                      append_images=animation[1:], duration=durations, loop=0,
                      quality=88, method=5)
    # Validate every record from its serialized ABI, including center identity.
    centers = []
    for i, frame in enumerate(frames):
        record = blob[frame["offset"]:frame["offset"] + frame["size"]]
        indices = zlib.decompress(record[512:])
        assert len(indices) == WIDTH * HEIGHT
        assert len(frame["eyes"]) == 2
        if i % STEPS == 0:
            centers.append(bytes(record))
        for eye in frame["eyes"]:
            assert all(math.isfinite(v) for v in eye.values())
            assert eye["rx"] > 0 and eye["ry"] > 0 and 0 <= eye["visibility"] <= 1
    assert all(center == centers[0] for center in centers)
    print(f"Validated {len(frames)} frames, {len(records)} unique records; "
          f"atlas {len(blob):,} bytes ({len(blob)/1024**2:.2f} MiB)")
    for path in (ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.json",
                 ROOT / "characters/copilot/legacy-atlas/generated/turn_atlas.h",
                 ROOT / "characters/copilot/legacy-atlas/src/turn_atlas.cpp",
                 preview / "turn-contact-sheet.png", preview / "turn-directions.webp"):
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
