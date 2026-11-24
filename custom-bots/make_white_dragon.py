"""White dragon girl voxel model (based on the Opus rig layout), written in the game's character JSON format."""
import json, sys, copy

SRC = sys.argv[1]   # public/assets/chars/opus.json
OUT = sys.argv[2]

d = json.load(open(SRC))
pal = {k: v.upper() for k, v in d['palette'].items()}

# ---------------- palette ----------------
P = dict(
    hair='#F4F1FA', hair_d='#CBC1E0', hair_hi='#FFFFFF',
    skin='#FFE4D4', blush='#FFA9B4',
    dress='#FAF9FD', dress_d='#DCD6EA', dress_dd='#C4BCD8',
    silver='#B6AFCB', silver_d='#8E87A6',
    horn='#DCD5E8', horn_d='#AFA4C6', horn_tip='#F7F5FB', ear_in='#F4C3B4',
    eye='#8D7BC9', eye_d='#6A57A6',
    wing_bone='#B3A9CB', wing_mem='#ECE7F6', wing_mem_d='#D6CCE9',
    scale='#F1EEF7', scale_d='#CFC6E0', spine='#A89EC2',
    shoe='#F4F2F9', leg='#FFE4D4',
)

remap = {
    pal['hair']: P['hair'], pal['hair_d']: P['hair_d'], pal['hair_hi']: P['hair_hi'],
    '#FFDCC2': P['skin'], '#FF9FA8': P['blush'],
    pal['cream']: '#FFFFFF', pal['mocha']: P['dress'], pal['mocha_l']: '#ECE8F4',
    pal['skirt']: P['dress'], pal['skirt_d']: P['dress_d'],
    pal['band']: P['silver_d'], pal['tights']: P['leg'], pal['shoe']: P['shoe'],
    pal['navy']: '#FFFFFF', pal['gold']: '#E4DFEE',
    pal['star']: P['silver_d'], pal['star_c']: '#FFFFFF',
    '#B5641C': P['eye'],   # iris (open / tight faces)
}

def recolor(c):
    return remap.get(c.upper(), c.upper())

for nm, p in d['parts'].items():
    p['voxels'] = [[x, y, z, recolor(c)] for x, y, z, c in p['voxels']]
    p['paint'] = [[x, y, z, f, recolor(c)] for x, y, z, f, c in p['paint']]
    p['slabs'] = [s[:6] + [recolor(s[6])] for s in p['slabs']]
# happy face: closed-eye arcs in the darker lavender
d['parts']['face_happy']['slabs'] = [s[:6] + [P['eye_d'] if s[6] == P['eye'] else s[6]] for s in d['parts']['face_happy']['slabs']]

def occ(part):
    return {(x, y, z) for x, y, z, _ in d['parts'][part]['voxels']}

def add(part, vox, color, overwrite=False):
    p = d['parts'][part]
    have = {(x, y, z): i for i, (x, y, z, _) in enumerate(p['voxels'])}
    for (x, y, z) in vox:
        if (x, y, z) in have:
            if overwrite:
                p['voxels'][have[(x, y, z)]][3] = color
            continue
        p['voxels'].append([x, y, z, color])
        have[(x, y, z)] = len(p['voxels']) - 1

# ---------------- head: horns + pointed ears ----------------
head = occ('head')
xs = [x for x, y, z in head]; zs = [z for x, y, z in head]
xmin, xmax, ztop = min(xs), max(xs), max(zs)
# horns rise from the top corners, curve outward, then sweep back (dragon horns, ridged)
def horn(side):
    # crescent: bulges outward from the side of the head, curls back in over the top and sweeps backwards
    sx = xmin if side < 0 else xmax
    o = -1 if side < 0 else 1
    H, R, T = P['horn'], P['horn_d'], P['horn_tip']
    return [((sx, 0, ztop - 1), H), ((sx, 1, ztop - 1), R),            # root in the hair
            ((sx + o, 0, ztop), R), ((sx + o, 1, ztop), H),            # outward bulge (2 thick)
            ((sx + o, 0, ztop + 1), H), ((sx + o, 1, ztop + 1), R),
            ((sx + o, 1, ztop + 2), H),
            ((sx, 1, ztop + 3), R), ((sx, 2, ztop + 3), H),            # curls back in over the head
            ((sx - o, 3, ztop + 3), R),
            ((sx - o, 4, ztop + 2), T)]                                # tip points backwards
for side in (-1, 1):
    for pos, col in horn(side):
        add('head', [pos], col)
# elf ears: two voxels poking out sideways at eye height, pointing up/back
for side in (-1, 1):
    ex = (xmin - 1) if side < 0 else (xmax + 1)
    o = -1 if side < 0 else 1
    add('head', [(ex, 0, 9), (ex, 0, 10), (ex + o, 0, 10), (ex + o, 1, 11)], P['skin'])
    add('head', [(ex, -1, 10)], P['ear_in'])

# ---------------- body: dragon wings (in the body part so they follow its lean / bob) ----------------
def wing(side):
    o = -1 if side < 0 else 1
    y = 4
    top = {3: 7, 4: 8, 5: 9, 6: 10, 7: 10, 8: 9}             # bone along the top edge
    bottom = {3: 5, 4: 4, 5: 5, 6: 4, 7: 6, 8: 7}            # scalloped lower edge
    bone = [(o * ax, y, z) for ax, z in top.items()] + [(o * 2, y, 6)]
    fingers = [(o * 5, y, 8), (o * 5, y, 7), (o * 5, y, 6), (o * 7, y, 9), (o * 7, y, 8), (o * 7, y, 7)]
    mem = [(o * ax, y, z) for ax in top for z in range(bottom[ax], top[ax])]
    return bone, fingers, mem
for side in (-1, 1):
    bone, fingers, mem = wing(side)
    add('body', mem, P['wing_mem'])
    add('body', [(x, y, z) for (x, y, z) in mem if z <= 5], P['wing_mem_d'], overwrite=True)
    add('body', fingers, P['wing_mem_d'], overwrite=True)
    add('body', bone, P['wing_bone'], overwrite=True)
    add('body', [(side * 6, 4, 11)], P['horn_d'])            # wing claw

# ---------------- tail: scaled dragon tail (rig part `tail`, hangs from the lower back) ----------------
tail_path = [(0, 3, 3), (0, 4, 2), (0, 5, 1), (0, 6, 1), (0, 7, 1), (0, 8, 2), (0, 8, 3), (0, 8, 4)]
tail = []
for i, (x, y, z) in enumerate(tail_path):
    tail.append([x, y, z, P['scale_d'] if i % 2 else P['scale']])
    if i < 5:   # 2 voxels wide for most of the length
        tail.append([x - 1, y, z, P['scale'] if i % 2 else P['scale_d']])
    if i < 2:   # thick root under the skirt
        tail.append([x, y, z + 1, P['scale']])
        tail.append([x - 1, y, z + 1, P['scale_d']])
for (x, y, z) in [(0, 4, 4), (0, 6, 2), (-1, 7, 2), (0, 7, 5)]:
    tail.append([x, y, z, P['spine']])
d['parts']['tail'] = {'pivot': [0.0, 3.0, 3.5], 'outline': True, 'voxels': tail, 'paint': [], 'slabs': []}

d['palette'] = P
d['key'] = 'dragon_girl'
d['label'] = '白龙'
d['color'] = '#B9A6E8'
d['hair_swing'] = 0.8
d['tail_rest'] = 0.15
json.dump(d, open(OUT, 'w'), ensure_ascii=False)
print('parts', list(d['parts']), 'voxels', sum(len(p['voxels']) for p in d['parts'].values()))
