#!/usr/bin/env python3
"""Training-ground scarecrow (稻草人) voxel model, written in the game's character JSON format.

Same rig layout and proportions as the chibi characters (voxkit coords: x right, -y front, z up, unit 0.07):
  footA / footB  wooden stake split in two halves (z 0..1)
  body           straw-stuffed plaid shirt with a rope belt, a blue patch and a straw fringe (z 2..5)
  armA / armB    stretched-out sleeves on the cross bar ending in straw tufts (the classic scarecrow T)
  head           burlap sack head tied at the neck, carrot nose, wide straw hat with a band (z 6..13)
  hairback       straw poking out behind the head under the hat brim (swings when running / kicked)
  face_*         stitched faces: button eyes + stitched smile / squint / happy arcs

Usage: python3 scripts/make_scarecrow.py public/assets/chars/scarecrow.json
"""
import json
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/assets/chars/scarecrow.json'

P = dict(
    straw='#EBC65A', straw_d='#C99A35', straw_hi='#F7DF8A',
    sack='#DDBA80', sack_d='#B8925A', sack_hi='#EBCFA0',
    shirt='#C9503A', shirt_d='#9B3828', shirt_hi='#E2734F',
    patch='#5B86B8', patch_d='#3F6592',
    rope='#8C6A3C', rope_d='#6E5230',
    wood='#8A5A33', wood_d='#6A4325',
    hat='#E2BB57', hat_d='#C49B3A', hat_hi='#F2D684', band='#3F6FB0',
    eye='#2E2238', stitch='#5A3A2A', nose='#E8812F', nose_d='#C9651E', blush='#E59A7A',
)


def part(pivot, outline=True):
    return {'pivot': [float(v) for v in pivot], 'outline': outline, 'voxels': [], 'paint': [], 'slabs': []}


def put(p, x, y, z, c):
    for v in p['voxels']:
        if v[0] == x and v[1] == y and v[2] == z:
            v[3] = c
            return
    p['voxels'].append([x, y, z, c])


parts = {}

# ---------------- stake (feet) ----------------
for nm, x, piv in (('footA', 0, [0.5, 0.5, 2.0]), ('footB', -1, [-0.5, 0.5, 2.0])):
    f = part(piv)
    for z in (0, 1):
        for y in (0, 1):
            put(f, x, y, z, P['wood'] if (y + z + x) % 2 == 0 else P['wood_d'])
    parts[nm] = f

# ---------------- body: plaid shirt, rope belt, straw fringe ----------------
body = part([0, 0, 0])
for x in range(-2, 2):
    for y in range(-1, 2):
        for z in range(2, 6):
            if z == 2:
                c = P['straw'] if (x + y) % 2 == 0 else P['straw_d']      # straw stuffing at the hem
            elif z == 3:
                c = P['rope'] if (x + y) % 2 == 0 else P['rope_d']        # rope belt
            else:
                c = P['shirt'] if (x + z) % 2 == 0 else P['shirt_d']      # pixel plaid
                if z == 5 and (x + y) % 2 == 0:
                    c = P['shirt_hi']
            put(body, x, y, z, c)
# straw fringe poking out under the belt
for (x, y) in ((-3, 0), (2, 0), (-2, -2), (1, -2), (-1, 2), (0, -2), (2, 1)):
    put(body, x, y, 2, P['straw_hi'] if (x + y) % 2 else P['straw'])
# blue patch with stitches on the chest (front face = -y, dir index 3)
body['paint'] += [[0, -1, 4, 3, P['patch']], [0, -1, 5, 3, P['patch_d']], [-2, -1, 4, 3, P['shirt_hi']]]
# collar straw
put(body, -1, 0, 6, P['straw'])
put(body, 0, 0, 6, P['straw_d'])
parts['body'] = body

# ---------------- arms: stretched sleeves ending in straw tufts ----------------
for nm, s, piv in (('armA', 1, [2.5, 0.5, 5.5]), ('armB', -1, [-2.5, 0.5, 5.5])):
    a = part(piv)
    base = 2 if s > 0 else -3
    for i in range(3):
        x = base + s * i
        put(a, x, 0, 5, P['shirt'] if i % 2 == 0 else P['shirt_d'])
        if i < 2:
            put(a, x, 0, 4, P['shirt_d'] if i % 2 == 0 else P['shirt'])
    hx = base + s * 3
    put(a, hx, 0, 5, P['straw'])
    put(a, hx, 0, 4, P['straw_d'])
    put(a, hx + s, 0, 5, P['straw_hi'])
    put(a, hx, 0, 3, P['straw'])
    put(a, hx + s, -1 if s > 0 else 1, 4, P['straw'])
    parts[nm] = a

# ---------------- head: burlap sack + straw hat ----------------
head = part([0, 0.5, 6.0])
for x in range(-3, 3):
    for y in range(-2, 3):
        for z in range(6, 12):
            corner = (x in (-3, 2)) and (y in (-2, 2))
            if corner and z in (6, 11):
                continue
            if z == 6:
                c = P['rope'] if (x + y) % 2 == 0 else P['rope_d']       # tied neck
            else:
                c = P['sack'] if (x * 3 + y + z) % 4 else P['sack_d']    # burlap weave speckle
                if z == 11:
                    c = P['sack_hi'] if (x + y) % 2 else P['sack']
            put(head, x, y, z, c)
# straw sticking out of the neck tie
for (x, y) in ((-4, 0), (3, 0), (-2, -3), (1, -3), (-3, 2), (2, 2)):
    put(head, x, y, 6, P['straw'] if (x + y) % 2 else P['straw_hi'])
# hat: brim at z=12 overhanging the sack by one voxel (keeps the face visible from the 58° top-down camera),
# narrower crown z=13..14 with a band at z=13
for x in range(-4, 4):
    for y in range(-3, 4):
        if (x in (-4, 3)) and (y in (-3, 3)):
            continue
        put(head, x, y, 12, P['hat'] if (x + y) % 2 == 0 else P['hat_d'])
for x in range(-2, 2):
    for y in range(-1, 2):
        put(head, x, y, 13, P['band'])
        put(head, x, y, 14, P['hat_hi'] if (x + y) % 2 == 0 else P['hat'])
put(head, -1, 0, 15, P['hat_d'])
put(head, 0, 0, 15, P['hat'])
# straw hair under the brim at both sides
for (x, z) in ((-4, 10), (-4, 11), (3, 10), (3, 11), (-4, 9), (3, 9)):
    put(head, x, 0 if z != 9 else 1, z, P['straw'] if z % 2 else P['straw_d'])
# carrot nose (slab, centred) and cheek blush
head['slabs'] += [
    [-0.5, 0.5, -2.85, -2.0, 7.6, 8.4, P['nose']],
    [-0.35, 0.35, -3.25, -2.85, 7.75, 8.25, P['nose_d']],
]
head['paint'] += [[-3, -2, 7, 3, P['blush']], [2, -2, 7, 3, P['blush']]]
parts['head'] = head

# ---------------- hairback: straw behind the head ----------------
hb = part([0, 2.5, 11.0])
for x in range(-2, 2):
    for z in (8, 9, 10, 11):
        if (x + z) % 2 == 0 or z == 11:
            put(hb, x, 3, z, P['straw'] if (x + z) % 3 else P['straw_d'])
for x in (-2, 1):
    put(hb, x, 3, 7, P['straw_hi'])
parts['hairback'] = hb

# ---------------- faces (slabs on the front plane y = -2) ----------------
FY0, FY1 = -2.11, -1.9


def face(slabs):
    f = part([0, 0.5, 6.0], outline=False)
    f['slabs'] = [[x0, x1, FY0, FY1, z0, z1, c] for (x0, x1, z0, z1, c) in slabs]
    return f


stitch_mouth = [(-1.6, 1.6, 6.85, 7.05, P['stitch'])] + [(x - 0.07, x + 0.07, 6.65, 7.25, P['stitch']) for x in (-1.2, -0.4, 0.4, 1.2)]
parts['face_open'] = face([
    (-2.1, -0.9, 8.6, 9.8, P['eye']), (-1.75, -1.45, 9.35, 9.6, '#FFFFFF'),   # button eyes
    (0.9, 2.1, 8.6, 9.8, P['eye']), (1.25, 1.55, 9.35, 9.6, '#FFFFFF'),
    *stitch_mouth,
])
parts['face_tight'] = face([
    (-2.2, -0.8, 9.0, 9.35, P['eye']), (0.8, 2.2, 9.0, 9.35, P['eye']),
    (-0.9, 0.9, 6.85, 7.1, P['stitch']),
])
parts['face_happy'] = face([
    (-2.2, -0.8, 9.4, 9.7, P['eye']), (-2.2, -1.9, 8.9, 9.4, P['eye']), (-1.1, -0.8, 8.9, 9.4, P['eye']),
    (0.8, 2.2, 9.4, 9.7, P['eye']), (0.8, 1.1, 8.9, 9.4, P['eye']), (1.9, 2.2, 8.9, 9.4, P['eye']),
    (-1.6, 1.6, 6.6, 6.9, P['stitch']), (-1.6, -1.3, 6.9, 7.3, P['stitch']), (1.3, 1.6, 6.9, 7.3, P['stitch']),
])

model = {
    'key': 'scarecrow',
    'unit': 0.07,
    'hz': 6,
    'scale': 1.0,
    'arm_len': 1.2,
    'hair_swing': 0.6,
    'tail_rest': 0.0,
    'palette': P,
    'parts': parts,
    'color': '#E39A3B',
    'label': '稻草人',
}
with open(OUT, 'w') as fh:
    json.dump(model, fh, ensure_ascii=False)
print('parts', list(parts), 'voxels', sum(len(p['voxels']) for p in parts.values()))
