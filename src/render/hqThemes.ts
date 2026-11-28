/**
 * Faithful theme data ported from the original open-source `chen-006/meow-ai-arena`
 * Blender renderer (`themes.py`, `scene_lib.py`, `ground_paint.py`).
 * Drives High Quality procedural ground painting, Voronoi-style rounded cliffs,
 * detailed themed 3D structures, lush curved tall grass + tip flowers, ground details,
 * outer scenic islands + signature landmarks, waterfalls, and lighting.
 */

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

export interface HqPalette {
  lip: string;
  soil: string;
  rock_a: string;
  rock_b: string;
  rock_c: string;
  rock_deep: string;
  rock_under: string;
  ledge_hi: string;
  stone_top: string;
  stone_lit: string;
  stone_side: string;
  stone_shade: string;
  stone_base: string;
  moss: string;
  tall_base: string;
  tall_mid: string;
  tall_tip: string;
  tall_flower: string[];
  tuft_dark: string;
  tuft_light: string;
  plant0: string;
  plant1: string;
  flower_main: string[];
  flower_acc: string[];
  flower_core: string;
  leaf_fall: string[];
  grass: string;
  grass2: string;
  grass_rim: string;
  tree_pals: [number, [string, string, string]][];
  pine_pal: [string, string, string];
  bush_pal: [string, string];
  trunk: string;
  crown_pal?: [string, string, string];
  spire_bands?: string[];
  cloud: string;
  cloud_shade: string;
  sky: string;
  sky_deep: string;
  ambient: string;
  haze: string;
}

export interface HqGroundColors {
  mid: RGB;
  light: RGB;
  dark: RGB;
  lush: RGB;
  rim: RGB;
  clover: RGB;
  dirt: RGB;
  dirt_hi: RGB;
  dirt_lo: RGB;
  dirt_rim: RGB;
  tall: RGB;
  tick_light: RGBA;
  tick_dark: RGBA;
  pebble_a: RGBA;
  pebble_b: RGBA;
  slab?: RGB;
  slab_hi?: RGB;
  slab_lo?: RGB;
  joint?: RGB;
  strata?: RGB;
  root?: RGB;
  /** Episode 12 caldera: glowing crack colour / brighter core / heat-baked rim around the lava lake. */
  glow?: RGB;
  glow_hi?: RGB;
  heat?: RGB;
  /** Episode 12 keeps: inlay colours of the last-collapsing plaza (star + centre). */
  emblem?: RGB;
  emblem2?: RGB;
}

export interface HqRockStyle {
  kind: 'rocks' | 'garden' | 'menhir' | 'crates' | 'masonry' | 'hoodoo' | 'houses' | 'trees' | 'basalt' | 'harbor' | 'castle';
  h: number;
  top: [number, number];
  n: [number, number];
  p: number;
  mossy: number;
  bands?: string[];
  /** Episode 12 keeps: flag colours that replace the team red / blue (left castle blue, right castle red). */
  red?: string;
  blue?: string;
}

export interface HqLightConfig {
  az: number;
  el: number;
  energy: number;
  color: [number, number, number];
  ambient: number;
}

export interface HqDecorConfig {
  pines: number;
  mix: [number, string][] | null;
  features: string[];
  /** `'lava'` (episode 12 caldera): a molten-rock fall instead of water, without mist. */
  waterfall: boolean | 'lava';
  bushes: boolean;
  density: number;
  dz: number;
}

export interface HqGroundStyle {
  pave?: 'near' | 'all';
  ring?: boolean;
  ripples?: boolean;
  strata?: boolean;
  heather?: RGB[];
  planks?: number;
  wood?: RGB[];
  litter?: RGB[];
  roots?: boolean;
  petals?: RGB[];
  ticks?: 'none';
  /** Episode 12 caldera: ash ground, glowing cracks & cooled-lava plates, heat rim around the lava lake. */
  ash?: boolean;
  /** Episode 12 harbor: land strips narrower than 2 x deck metres next to the sea become wooden piers. */
  deck?: number;
  /** Episode 12 keeps: tiled castle floors, plaza slabs, last-collapse inlay, pond coping. */
  castle?: boolean;
}

export interface HqDetailConfig {
  tuft: number;
  flower: number;
  pebble: number;
  leaf: number;
  extras: string[];
}

export interface HqAmbientConfig {
  cols: string[];
  n: number;
  size: number;
  speed: number;
  /** Rising embers (mostly born over the lava lake) instead of falling bits. */
  rise?: boolean;
  /** Emission strength (> 0 = glowing embers). */
  glow?: number;
  /** A second kind of floating bits (caldera: ash falling while embers rise). */
  extra?: HqAmbientConfig;
}

/** Episode 12 liquid surface in pits (`themes.py` liquid key, `liquid.py`). */
export interface HqLiquidSpec {
  kind: 'lava' | 'water';
  /** Surface height (m, ground = 0). */
  z: number;
  /** `enclosed` = only pits surrounded by land that don't touch the map border. */
  where: 'enclosed' | 'all';
  minCells: number;
}

export interface HqThemeSpec {
  name: string;
  pal: HqPalette;
  ground: HqGroundColors;
  rock: HqRockStyle;
  light: HqLightConfig;
  decor: HqDecorConfig;
  gstyle: HqGroundStyle;
  detail: HqDetailConfig;
  field: string[];
  ambient: HqAmbientConfig | null;
  liquid: HqLiquidSpec | null;
}

const BASE_PAL: HqPalette = {
  lip: '#7EC452',
  soil: '#B98558',
  rock_a: '#F7D29A',
  rock_b: '#ECA978',
  rock_c: '#D88D72',
  rock_deep: '#9E82BA',
  rock_under: '#7E6CA8',
  ledge_hi: '#FFF2CC',
  stone_top: '#F7DFB2',
  stone_lit: '#E8BC8A',
  stone_side: '#D29A7C',
  stone_shade: '#9A78A0',
  stone_base: '#7D6892',
  moss: '#7EC452',
  tall_base: '#2D884C',
  tall_mid: '#52B456',
  tall_tip: '#B4E36E',
  tall_flower: [],
  tuft_dark: '#469E4E',
  tuft_light: '#B2E26C',
  plant0: '#358E4E',
  plant1: '#8CD464',
  flower_main: ['#FFFFFF', '#FFF199', '#FFE066'],
  flower_acc: ['#FF90A8', '#FFB8C8', '#FFFFFF'],
  flower_core: '#F8BE3C',
  leaf_fall: ['#E8BE5A', '#D6944A', '#A8D064'],
  grass: '#88C852',
  grass2: '#A8DA66',
  grass_rim: '#C8EA78',
  tree_pals: [
    [0.7, ['#3D9C56', '#60BE62', '#A8E27A']],
    [0.3, ['#54AE52', '#82CF64', '#CBEB82']],
  ],
  pine_pal: ['#286E52', '#3F9664', '#86CC84'],
  bush_pal: ['#44A056', '#9ADE72'],
  trunk: '#845C44',
  cloud: '#FFFFFF',
  cloud_shade: '#D3E2FA',
  sky: '#C8E6FF',
  sky_deep: '#6DB6F2',
  ambient: '#B8D4FF',
  haze: '#BFDDF8',
};

const BASE_GROUND: HqGroundColors = {
  mid: [134, 198, 84],
  light: [176, 220, 102],
  dark: [96, 170, 76],
  lush: [74, 152, 74],
  rim: [204, 232, 122],
  clover: [112, 186, 86],
  dirt: [224, 192, 134],
  dirt_hi: [242, 214, 156],
  dirt_lo: [188, 152, 104],
  dirt_rim: [122, 168, 82],
  tall: [62, 136, 72],
  tick_light: [212, 240, 132, 105],
  tick_dark: [64, 136, 68, 90],
  pebble_a: [164, 136, 106, 195],
  pebble_b: [238, 224, 194, 210],
};

const BASE_SPEC: HqThemeSpec = {
  name: 'meadow',
  pal: BASE_PAL,
  ground: BASE_GROUND,
  rock: { kind: 'rocks', h: 1.0, top: [0.5, 0.68], n: [5, 8], p: 3.2, mossy: 0.55 },
  light: { az: 150, el: 55, energy: 4.6, color: [1.0, 0.925, 0.8], ambient: 0.6 },
  decor: { pines: 0.4, mix: null, features: [], waterfall: true, bushes: true, density: 1.0, dz: 0.0 },
  gstyle: {},
  detail: { tuft: 1.5, flower: 0.16, pebble: 0.3, leaf: 0.22, extras: [] },
  field: [],
  ambient: { cols: ['#FFFFFF', '#FFF6C8'], n: 14, size: 0.035, speed: 0.7 },
  liquid: null,
};

interface PartialThemeOverride {
  pal?: Partial<HqPalette>;
  ground?: Partial<HqGroundColors>;
  rock?: Partial<HqRockStyle>;
  light?: Partial<HqLightConfig>;
  decor?: Partial<HqDecorConfig>;
  gstyle?: HqGroundStyle;
  detail?: Partial<HqDetailConfig>;
  field?: string[];
  ambient?: HqAmbientConfig | null;
  liquid?: HqLiquidSpec | null;
}

const OVERRIDES: Record<string, PartialThemeOverride> = {
  meadow: {},
  glacier: {
    pal: {
      lip: '#EEF6FD',
      soil: '#9CC8E6',
      rock_a: '#C6E4F4',
      rock_b: '#93C7E8',
      rock_c: '#62A2D8',
      rock_deep: '#4B70C4',
      rock_under: '#3E5CAE',
      haze: '#CFE4F8',
      ledge_hi: '#FFFFFF',
      stone_top: '#F6FCFF',
      stone_lit: '#C4E8F9',
      stone_side: '#8FCAEF',
      stone_shade: '#5F90DA',
      stone_base: '#4C74C2',
      moss: '#FFFFFF',
      tall_base: '#8A6A3A',
      tall_mid: '#C9A05A',
      tall_tip: '#F6E3AC',
      tuft_dark: '#93B6CC',
      tuft_light: '#F6FBFF',
      plant0: '#9DBFD4',
      plant1: '#F2F8FC',
      flower_main: ['#FFFFFF', '#DFF3FF', '#BFE6FF'],
      flower_acc: ['#FF8FA8', '#FFC2D1', '#FF6F91'],
      flower_core: '#9AD0F0',
      leaf_fall: ['#FFFFFF', '#D6EAF8', '#BFD9EE'],
      grass: '#E6F1FA',
      grass2: '#F8FCFF',
      grass_rim: '#FFFFFF',
      tree_pals: [
        [0.7, ['#C2DAEC', '#E2EFF8', '#FFFFFF']],
        [0.3, ['#7FB0C8', '#B4D6E6', '#F4FBFF']],
      ],
      pine_pal: ['#2E6F7A', '#4E9CA2', '#F2FAFF'],
      bush_pal: ['#BCD6E8', '#F4FAFF'],
      trunk: '#7A6A70',
      cloud: '#FFFFFF',
      cloud_shade: '#C9DBF2',
      sky: '#CFE6F7',
      sky_deep: '#6FA9DC',
      ambient: '#B4CCF2',
    },
    ground: {
      mid: [226, 238, 248],
      light: [246, 251, 255],
      dark: [198, 220, 240],
      lush: [178, 208, 234],
      rim: [255, 255, 255],
      dirt: [150, 205, 234],
      dirt_hi: [192, 230, 246],
      dirt_lo: [118, 178, 218],
      tall: [186, 206, 220],
      clover: [204, 228, 246],
      dirt_rim: [170, 200, 226],
      tick_light: [255, 255, 255, 120],
      tick_dark: [150, 186, 216, 90],
      pebble_a: [110, 160, 205, 200],
      pebble_b: [235, 248, 255, 220],
    },
    rock: { h: 1.35, top: [0.2, 0.36], n: [5, 7], p: 2.6, mossy: 0.25 },
    light: { az: 150, el: 46, energy: 4.2, color: [1.0, 0.96, 0.9], ambient: 0.78 },
    decor: { pines: 0.75 },
    ambient: { cols: ['#FFFFFF', '#EAF6FF'], n: 90, size: 0.04, speed: 0.8 },
  },
  blossom: {
    pal: {
      tall_base: '#3E9E58',
      tall_mid: '#6CC462',
      tall_tip: '#C4EC84',
      tall_flower: ['#FF9CC0', '#FFFFFF', '#FFC6DC', '#FF7FA8'],
      moss: '#FFC4D8',
      flower_main: ['#FFFFFF', '#FFD6E4', '#FFA9C6'],
      flower_acc: ['#FF7FA8', '#FFE27A', '#FFFFFF'],
      leaf_fall: ['#FFB7D0', '#FFD6E4', '#FF9CBC'],
      tree_pals: [
        [0.7, ['#F08FA8', '#F9B4C6', '#FFE0EA']],
        [0.3, ['#45A862', '#66C46C', '#A4E07E']],
      ],
      stone_top: '#F8E6DC',
      stone_lit: '#EDC8B8',
      stone_side: '#D3A6A2',
      sky: '#C4E6FA',
      sky_deep: '#7FC4F2',
    },
    ground: {
      mid: [150, 204, 96],
      light: [186, 222, 110],
      dark: [112, 180, 88],
      lush: [248, 176, 196],
      clover: [255, 150, 182],
      dirt: [232, 206, 150],
      tall: [120, 184, 100],
    },
    rock: { kind: 'garden', h: 0.95, top: [0.5, 0.66], mossy: 0.85 },
    decor: {
      pines: 0.0,
      mix: [
        [0.85, 'sakura'],
        [0.15, 'round'],
      ],
      features: ['torii', 'lantern', 'lantern'],
    },
    gstyle: {
      petals: [
        [255, 190, 212],
        [255, 226, 236],
        [255, 160, 192],
      ],
    },
    detail: { tuft: 1.2, flower: 0.2, pebble: 0.2, leaf: 0.9, extras: [] },
    ambient: { cols: ['#FFB7D0', '#FFD6E4', '#FF9CBC', '#FFFFFF'], n: 70, size: 0.07, speed: 0.9 },
  },
  heath: {
    pal: {
      lip: '#93B060',
      soil: '#8A7A6A',
      rock_a: '#D9D6CC',
      rock_b: '#B8B6B0',
      rock_c: '#9A9AA2',
      rock_deep: '#7F84A8',
      rock_under: '#6A70A0',
      stone_top: '#E2E7EE',
      stone_lit: '#BCC6D4',
      stone_side: '#909CB2',
      stone_shade: '#6C7896',
      stone_base: '#5A6484',
      moss: '#A7B86A',
      tall_base: '#5A4A7A',
      tall_mid: '#8E6CB4',
      tall_tip: '#D9A6E8',
      tuft_dark: '#6E8F4A',
      tuft_light: '#C6D07A',
      flower_main: ['#D9A6E8', '#B987D6', '#FFFFFF'],
      flower_acc: ['#FFE27A', '#F3B6F2', '#FFFFFF'],
      grass: '#9CB866',
      grass2: '#BCCB78',
      grass_rim: '#C8D488',
      tree_pals: [
        [0.6, ['#4E8A5A', '#6EA868', '#A8CC84']],
        [0.4, ['#B58ACB', '#CFA6DE', '#EBD2F2']],
      ],
      sky: '#D9E4EE',
      sky_deep: '#9DB7D4',
      cloud_shade: '#C4CEE2',
      ambient: '#B0BEDC',
      haze: '#D2DCEA',
    },
    ground: {
      mid: [150, 178, 96],
      light: [186, 200, 110],
      dark: [120, 150, 84],
      lush: [152, 112, 182],
      rim: [196, 208, 128],
      clover: [178, 124, 198],
      dirt: [196, 170, 128],
      dirt_hi: [214, 192, 150],
      dirt_lo: [166, 140, 108],
      tall: [96, 84, 128],
      dirt_rim: [120, 140, 80],
    },
    rock: { kind: 'menhir', h: 1.0, top: [0.62, 0.8], n: [4, 5], p: 4.5, mossy: 0.0 },
    light: { az: 150, el: 50, energy: 3.9, color: [1.0, 0.95, 0.88], ambient: 0.72 },
    decor: {
      pines: 0.5,
      mix: [
        [0.45, 'pine'],
        [0.2, 'bare'],
        [0.35, 'heather'],
      ],
      features: ['menhirs', 'menhirs', 'menhirs'],
      bushes: false,
      density: 0.55,
    },
    gstyle: {
      heather: [
        [170, 110, 196],
        [206, 150, 224],
        [140, 92, 170],
      ],
      ring: true,
    },
    detail: { tuft: 1.3, flower: 0.3, pebble: 0.5, leaf: 0.05, extras: ['heather'] },
    ambient: { cols: ['#D9A6E8', '#FFFFFF', '#B987D6'], n: 22, size: 0.045, speed: 0.7 },
  },
  sunset: {
    pal: {
      lip: '#B8B84A',
      soil: '#B8704A',
      rock_a: '#FFC98A',
      rock_b: '#F5A26A',
      rock_c: '#E07F5E',
      rock_deep: '#A65E9A',
      rock_under: '#7A4E9E',
      haze: '#FFD9C2',
      stone_top: '#FFE0A0',
      stone_lit: '#F7B070',
      stone_side: '#D98660',
      stone_shade: '#9A5E96',
      stone_base: '#7A4E92',
      moss: '#C9C24A',
      tall_base: '#7A7A2E',
      tall_mid: '#C9B24A',
      tall_tip: '#FFE58A',
      tuft_dark: '#8A9A3A',
      tuft_light: '#F0DC70',
      grass: '#BCC050',
      grass2: '#E0D060',
      grass_rim: '#F0E080',
      tree_pals: [
        [0.5, ['#D98A3A', '#F0A84A', '#FFD27A']],
        [0.5, ['#C8604A', '#E8825E', '#FFB48A']],
      ],
      pine_pal: ['#5A6E3E', '#8A9A4A', '#E0C870'],
      cloud: '#FFF1E0',
      cloud_shade: '#F7B7A8',
      sky: '#FFD2A8',
      sky_deep: '#F59A8C',
      ambient: '#C9A6E0',
    },
    ground: {
      mid: [170, 190, 84],
      light: [214, 206, 98],
      dark: [128, 160, 78],
      lush: [110, 150, 84],
      rim: [236, 222, 120],
      dirt: [236, 190, 130],
      dirt_hi: [250, 212, 150],
      dirt_lo: [206, 150, 100],
      tall: [110, 120, 60],
    },
    light: { az: 205, el: 34, energy: 5.0, color: [1.0, 0.76, 0.52], ambient: 0.6 },
    decor: {
      pines: 0.0,
      mix: [
        [0.5, 'round'],
        [0.3, 'cypress'],
        [0.2, 'bare'],
      ],
      features: ['lamp', 'lamp', 'lamp', 'lamp'],
    },
    rock: { kind: 'crates' },
    gstyle: {
      planks: 0.8,
      wood: [
        [178, 120, 78],
        [150, 98, 66],
        [206, 146, 96],
      ],
    },
    detail: { tuft: 1.3, flower: 0.12, pebble: 0.3, leaf: 0.5, extras: [] },
    field: ['bridges'],
    ambient: { cols: ['#F0A84A', '#E8825E', '#FFD27A'], n: 34, size: 0.075, speed: 0.8 },
  },
  ruins: {
    pal: {
      lip: '#86BE62',
      soil: '#A08A6E',
      rock_a: '#EADCB8',
      rock_b: '#D2C09A',
      rock_c: '#B4A088',
      rock_deep: '#8A80A8',
      rock_under: '#6E6AA0',
      stone_top: '#F2DFB0',
      stone_lit: '#DEC896',
      stone_side: '#C2A678',
      stone_shade: '#9A8C9A',
      stone_base: '#7E6A70',
      moss: '#86B24E',
      grass: '#8EC068',
      grass2: '#B0D27A',
      grass_rim: '#C4DE8C',
      tree_pals: [
        [0.8, ['#3E8A56', '#5EAA64', '#98CC7C']],
        [0.2, ['#D9A441', '#EFC45A', '#F9E28E']],
      ],
      sky: '#C6E4EC',
      sky_deep: '#86BFD6',
      haze: '#CDE2EA',
    },
    ground: {
      mid: [142, 192, 104],
      light: [180, 212, 116],
      dark: [106, 168, 92],
      lush: [80, 150, 88],
      rim: [200, 224, 136],
      clover: [96, 160, 96],
      dirt: [214, 198, 152],
      dirt_hi: [230, 216, 172],
      dirt_lo: [180, 164, 124],
      tall: [66, 134, 76],
      dirt_rim: [120, 160, 90],
      slab: [222, 216, 196],
      slab_hi: [238, 234, 216],
      slab_lo: [196, 190, 170],
    },
    rock: { kind: 'masonry', h: 1.0, mossy: 0.2 },
    decor: {
      pines: 0.3,
      mix: [
        [0.6, 'round'],
        [0.25, 'cypress'],
        [0.15, 'pine'],
      ],
      features: ['columns', 'arch', 'columns'],
    },
    gstyle: { pave: 'near' },
    ambient: { cols: ['#B4D080', '#EFC45A', '#98CC7C'], n: 22, size: 0.065, speed: 0.7 },
    detail: { tuft: 1.6, flower: 0.2, pebble: 0.5, leaf: 0.25, extras: ['rubble'] },
  },
  dunes: {
    pal: {
      lip: '#F2D896',
      soil: '#D9A86A',
      rock_a: '#FFD79A',
      rock_b: '#F2B26E',
      rock_c: '#DB8A58',
      rock_deep: '#A066A0',
      rock_under: '#7E549C',
      stone_top: '#FFE4AC',
      stone_lit: '#F5BA7A',
      stone_side: '#DB905E',
      stone_shade: '#A8688C',
      stone_base: '#8A5A90',
      moss: '#FFEFC0',
      tuft_dark: '#8AA24A',
      tuft_light: '#D8E07A',
      grass: '#F0D890',
      grass2: '#FAE8B0',
      grass_rim: '#FFF2C8',
      leaf_fall: ['#FFF2C8', '#F2C078', '#E8D48A'],
      tree_pals: [[1.0, ['#3E9A58', '#6CC060', '#B4E47A']]],
      sky: '#A4DAF8',
      sky_deep: '#4FA8EE',
      spire_bands: ['#FFE2A8', '#F2B470', '#E0905A', '#FBD08C'],
    },
    ground: {
      mid: [238, 214, 150],
      light: [250, 232, 176],
      dark: [222, 190, 124],
      lush: [150, 190, 96],
      rim: [255, 240, 196],
      clover: [130, 180, 90],
      dirt: [214, 176, 112],
      dirt_hi: [230, 196, 132],
      dirt_lo: [190, 150, 96],
      tall: [120, 160, 80],
      dirt_rim: [200, 170, 110],
      tick_light: [255, 246, 210, 120],
      tick_dark: [200, 164, 104, 90],
    },
    rock: { kind: 'hoodoo', h: 1.0, bands: ['#FFE2A8', '#F2B470', '#E0905A', '#FBD08C'] },
    light: { az: 150, el: 58, energy: 4.9, color: [1.0, 0.93, 0.78], ambient: 0.62 },
    decor: {
      pines: 0.0,
      mix: [
        [0.55, 'palm'],
        [0.3, 'cactus'],
        [0.15, 'spire'],
      ],
      features: ['arch_rock'],
      waterfall: false,
      bushes: false,
      density: 0.5,
    },
    gstyle: { ripples: true, ticks: 'none' },
    ambient: null,
    detail: { tuft: 0.25, flower: 0.03, pebble: 0.5, leaf: 0.0, extras: ['cactus', 'dryshrub'] },
  },
  canyon: {
    pal: {
      lip: '#E8A070',
      soil: '#C0623E',
      rock_a: '#F0A070',
      rock_b: '#DC7A52',
      rock_c: '#C05A44',
      rock_deep: '#8A4A80',
      rock_under: '#6A3E84',
      haze: '#F2D2C4',
      stone_top: '#F9B884',
      stone_lit: '#E88E5E',
      stone_side: '#C46642',
      stone_shade: '#8A4A6E',
      stone_base: '#70407A',
      moss: '#B8BE6A',
      tall_base: '#6E7A3A',
      tall_mid: '#A8B25A',
      tall_tip: '#E6E08A',
      tuft_dark: '#7E8A46',
      tuft_light: '#D6D680',
      grass: '#E09868',
      grass2: '#F0B480',
      grass_rim: '#F6C494',
      flower_main: ['#FFE27A', '#FFFFFF', '#FFC24A'],
      tree_pals: [
        [0.6, ['#7E8A46', '#A8B25A', '#DADC8A']],
        [0.4, ['#D9A441', '#EFC45A', '#F9E28E']],
      ],
      pine_pal: ['#5A7A4A', '#86A45E', '#C8D88A'],
      sky: '#A8D8F5',
      sky_deep: '#58AEEA',
      spire_bands: ['#F2A070', '#D8704A', '#B8503E', '#E89A6C', '#C8603F'],
    },
    ground: {
      mid: [226, 150, 96],
      light: [242, 178, 116],
      dark: [202, 122, 84],
      lush: [160, 174, 96],
      rim: [250, 198, 138],
      clover: [140, 160, 84],
      dirt: [246, 210, 156],
      dirt_hi: [254, 228, 180],
      dirt_lo: [222, 180, 128],
      tall: [130, 130, 70],
      dirt_rim: [190, 110, 76],
      tick_light: [250, 200, 140, 110],
      tick_dark: [170, 90, 60, 90],
      strata: [172, 92, 68],
      pebble_a: [150, 84, 64, 200],
      pebble_b: [250, 214, 170, 210],
    },
    rock: { kind: 'hoodoo', h: 1.12, bands: ['#F2A070', '#D8704A', '#B8503E', '#E89A6C', '#C8603F'] },
    light: { az: 150, el: 56, energy: 4.8, color: [1.0, 0.92, 0.78], ambient: 0.6 },
    decor: {
      pines: 0.0,
      mix: [
        [0.45, 'spire'],
        [0.3, 'juniper'],
        [0.25, 'cactus'],
      ],
      features: ['arch_rock', 'spires'],
      waterfall: false,
      bushes: false,
      density: 0.55,
      dz: 0.6,
    },
    gstyle: {
      strata: true,
      ticks: 'none',
      planks: 1.4,
      wood: [
        [190, 136, 86],
        [160, 108, 70],
        [214, 160, 104],
      ],
    },
    detail: { tuft: 0.35, flower: 0.05, pebble: 0.7, leaf: 0.0, extras: ['dryshrub', 'cactus'] },
    field: ['bridges'],
    ambient: null,
  },
  oldtown: {
    pal: {
      lip: '#D8CDB4',
      soil: '#A89884',
      rock_a: '#E6D8BC',
      rock_b: '#D0BE9E',
      rock_c: '#B6A08C',
      rock_deep: '#9084A8',
      rock_under: '#746EA0',
      stone_top: '#EC7A52',
      stone_lit: '#F8EBCF',
      stone_side: '#E3D0AC',
      stone_shade: '#B6A0AC',
      stone_base: '#8E7C96',
      moss: '#D55E3E',
      grass: '#CFC4A8',
      grass2: '#E0D6BA',
      grass_rim: '#EAE0C6',
      tree_pals: [
        [0.75, ['#45A862', '#66C46C', '#A4E07E']],
        [0.25, ['#E2796B', '#F29A8A', '#FCC7B8']],
      ],
    },
    ground: {
      mid: [206, 192, 170],
      light: [226, 214, 190],
      dark: [180, 166, 150],
      lush: [120, 170, 96],
      rim: [236, 226, 204],
      clover: [110, 160, 90],
      dirt: [232, 222, 200],
      dirt_hi: [244, 236, 216],
      dirt_lo: [200, 188, 168],
      tall: [70, 136, 76],
      dirt_rim: [176, 164, 146],
      tick_light: [240, 232, 212, 110],
      tick_dark: [150, 138, 124, 90],
      slab: [224, 206, 174],
      slab_hi: [240, 226, 198],
      slab_lo: [200, 180, 152],
      joint: [150, 132, 114],
    },
    rock: { kind: 'houses' },
    decor: {
      pines: 0.0,
      mix: [
        [0.55, 'house'],
        [0.3, 'round'],
        [0.15, 'cypress'],
      ],
      features: ['tower', 'tower'],
      waterfall: false,
      bushes: true,
      density: 0.8,
    },
    gstyle: { pave: 'all', ring: true, ticks: 'none' },
    detail: { tuft: 0.3, flower: 0.05, pebble: 0.15, leaf: 0.3, extras: ['pots'] },
    field: ['fountain'],
    ambient: null,
  },
  forest: {
    pal: {
      lip: '#5AA050',
      soil: '#7A5A44',
      rock_a: '#C9B894',
      rock_b: '#A8946E',
      rock_c: '#8A7860',
      rock_deep: '#6E6690',
      rock_under: '#585488',
      stone_top: '#CFC5AC',
      stone_lit: '#AEA28C',
      stone_side: '#8A7F76',
      stone_shade: '#6A6480',
      stone_base: '#575272',
      moss: '#5EAE4E',
      tall_base: '#1F6A44',
      tall_mid: '#3C9A56',
      tall_tip: '#8AD06A',
      tuft_dark: '#2F7E46',
      tuft_light: '#8AD06A',
      grass: '#62A656',
      grass2: '#86BE62',
      grass_rim: '#96C86A',
      flower_main: ['#FFFFFF', '#FF6A5A', '#FFD84A'],
      flower_acc: ['#FF6A5A', '#FFFFFF', '#F3B6F2'],
      leaf_fall: ['#D9A441', '#B8743A', '#E8C25A'],
      tree_pals: [
        [0.7, ['#2F8050', '#479E5A', '#84C672']],
        [0.3, ['#3E9A6A', '#62B87A', '#A6DC96']],
      ],
      pine_pal: ['#1F6652', '#2F8462', '#6CB886'],
      sky: '#B9DCE8',
      sky_deep: '#6FAFC8',
      ambient: '#96B6DC',
      haze: '#BEDCE4',
      crown_pal: ['#2A7A4C', '#46A05A', '#9AD476'],
    },
    ground: {
      mid: [96, 160, 84],
      light: [140, 190, 96],
      dark: [66, 130, 76],
      lush: [50, 112, 72],
      rim: [150, 200, 104],
      clover: [60, 130, 80],
      dirt: [150, 120, 84],
      dirt_hi: [176, 146, 104],
      dirt_lo: [120, 94, 70],
      tall: [40, 104, 66],
      dirt_rim: [70, 110, 64],
      tick_light: [170, 214, 120, 100],
      tick_dark: [40, 100, 60, 90],
      root: [110, 82, 58],
    },
    rock: { kind: 'trees' },
    light: { az: 150, el: 52, energy: 4.4, color: [1.0, 0.9, 0.72], ambient: 0.52 },
    decor: {
      pines: 0.0,
      mix: [
        [0.7, 'bigtree'],
        [0.3, 'pine'],
      ],
      features: ['shrooms', 'shrooms'],
      density: 1.5,
    },
    ambient: { cols: ['#84C672', '#D9A441', '#A6DC96', '#E8C25A'], n: 36, size: 0.08, speed: 0.8 },
    gstyle: {
      litter: [
        [222, 160, 72],
        [186, 112, 60],
        [236, 198, 96],
      ],
      roots: true,
    },
    detail: { tuft: 1.8, flower: 0.1, pebble: 0.2, leaf: 1.2, extras: ['mushroom', 'fern'] },
  },
  // ---------------- Episode 12 (5v5 team matches): themes.py caldera / harbor / keeps
  caldera: {
    pal: {
      lip: '#7A6A6E',
      soil: '#5E4A4E',
      rock_a: '#8E7A7C',
      rock_b: '#6E5E68',
      rock_c: '#58506A',
      rock_deep: '#46426E',
      rock_under: '#3A3868',
      haze: '#E8C4C0',
      ledge_hi: '#C9A896',
      stone_top: '#B4AABC',
      stone_lit: '#76728A',
      stone_side: '#5E5C78',
      stone_shade: '#4A4862',
      stone_base: '#3A3850',
      moss: '#FF9A4A',
      tall_base: '#5E3A34',
      tall_mid: '#C0603E',
      tall_tip: '#FFC05A',
      tall_flower: ['#FFD46A', '#FF9A4A', '#FFE9A8'],
      tuft_dark: '#6E5A50',
      tuft_light: '#C8A070',
      plant0: '#6E5A50',
      plant1: '#B8946A',
      flower_main: ['#FFC24A', '#FF8A3A', '#FFE08A'],
      flower_acc: ['#FF6A3A', '#FFD46A', '#FFFFFF'],
      flower_core: '#FFF2C0',
      leaf_fall: ['#8A7E80', '#A89A98', '#6E6466'],
      grass: '#8A7A78',
      grass2: '#A08E88',
      grass_rim: '#B8A498',
      tree_pals: [
        [0.6, ['#C8503A', '#E8784A', '#FFB060']],
        [0.4, ['#8A6A5A', '#A88A6A', '#D6B88A']],
      ],
      pine_pal: ['#4A4A5A', '#6A6676', '#A89CA0'],
      bush_pal: ['#A8503E', '#E8884E'],
      trunk: '#3E3440',
      cloud: '#FBEAE6',
      cloud_shade: '#C8A0B4',
      sky: '#FFD2B8',
      sky_deep: '#E0909A',
      ambient: '#C8A8D0',
    },
    ground: {
      mid: [132, 116, 112],
      light: [178, 164, 152],
      dark: [92, 78, 84],
      lush: [104, 90, 92],
      rim: [184, 166, 152],
      clover: [110, 100, 104],
      dirt: [170, 156, 146],
      dirt_hi: [190, 176, 164],
      dirt_lo: [140, 126, 120],
      tall: [96, 70, 66],
      dirt_rim: [110, 98, 100],
      tick_light: [190, 176, 168, 90],
      tick_dark: [70, 62, 70, 80],
      pebble_a: [70, 64, 78, 210],
      pebble_b: [196, 180, 170, 200],
      glow: [255, 150, 60],
      glow_hi: [255, 226, 140],
      heat: [196, 104, 76],
    },
    rock: { kind: 'basalt', h: 1.0 },
    light: { az: 150, el: 50, energy: 4.5, color: [1.0, 0.86, 0.72], ambient: 0.6 },
    decor: {
      pines: 0.0,
      mix: [
        [0.4, 'basalt'],
        [0.35, 'charred'],
        [0.25, 'emberbush'],
      ],
      features: ['volcano', 'volcano', 'smoke'],
      waterfall: 'lava',
      bushes: false,
      density: 0.6,
    },
    gstyle: { ash: true, ticks: 'none' },
    detail: { tuft: 0.35, flower: 0.05, pebble: 0.6, leaf: 0.15, extras: ['obsidian', 'vent'] },
    liquid: { kind: 'lava', z: -0.5, where: 'enclosed', minCells: 1 },
    ambient: {
      cols: ['#FFB24A', '#FF7A3A', '#FFE08A'],
      n: 46,
      size: 0.035,
      speed: 0.9,
      rise: true,
      glow: 3.0,
      extra: { cols: ['#B8AEB0', '#8E8488', '#D8D0D0'], n: 26, size: 0.05, speed: 0.6 },
    },
  },
  harbor: {
    pal: {
      lip: '#F0DEB0',
      soil: '#C8A478',
      rock_a: '#F2DCB0',
      rock_b: '#E0C09A',
      rock_c: '#C8A08C',
      rock_deep: '#8A86B0',
      rock_under: '#6E74AA',
      haze: '#CDE6F4',
      stone_top: '#F4E6CA',
      stone_lit: '#E2CCA6',
      stone_side: '#C8AC8A',
      stone_shade: '#9A8EA2',
      stone_base: '#7E7494',
      moss: '#9CC870',
      tall_base: '#8A8A46',
      tall_mid: '#C8C070',
      tall_tip: '#F4ECB0',
      tuft_dark: '#8AA05A',
      tuft_light: '#D8DE8A',
      grass: '#F2E2B4',
      grass2: '#FAEED0',
      grass_rim: '#FFF6DE',
      leaf_fall: ['#FFFFFF', '#F2F2F2', '#E4ECF2'],
      tree_pals: [
        [0.7, ['#3E9A58', '#62B862', '#A6DC7E']],
        [0.3, ['#2E8A6A', '#4EAA7A', '#94D49A']],
      ],
      sky: '#A6DCF8',
      sky_deep: '#4CA4EC',
      cloud_shade: '#CBDDF4',
      ambient: '#A8C4F2',
    },
    ground: {
      mid: [240, 222, 172],
      light: [250, 238, 200],
      dark: [226, 204, 152],
      lush: [156, 186, 106],
      rim: [255, 246, 216],
      clover: [150, 182, 100],
      dirt: [222, 196, 146],
      dirt_hi: [236, 214, 168],
      dirt_lo: [200, 172, 124],
      tall: [160, 168, 96],
      dirt_rim: [214, 190, 140],
      tick_light: [255, 250, 226, 110],
      tick_dark: [206, 180, 128, 80],
      slab: [222, 214, 196],
      slab_hi: [238, 232, 216],
      slab_lo: [196, 188, 172],
      joint: [160, 150, 136],
    },
    rock: { kind: 'harbor' },
    light: { az: 150, el: 55, energy: 4.7, color: [1.0, 0.94, 0.84], ambient: 0.64 },
    decor: {
      pines: 0.0,
      mix: [
        [0.35, 'house'],
        [0.4, 'round'],
        [0.25, 'seastack'],
      ],
      features: ['lighthouse', 'boat', 'boat'],
      waterfall: true,
      bushes: true,
      density: 0.7,
    },
    gstyle: {
      deck: 2.0,
      ripples: true,
      ticks: 'none',
      wood: [
        [196, 150, 104],
        [170, 124, 86],
        [216, 174, 124],
      ],
    },
    detail: { tuft: 0.6, flower: 0.05, pebble: 0.4, leaf: 0.0, extras: ['shells', 'drygrass'] },
    field: ['piers'],
    liquid: { kind: 'water', z: -0.4, where: 'enclosed', minCells: 1 },
    ambient: { cols: ['#FFFFFF', '#F2F6FA'], n: 8, size: 0.05, speed: 0.5 },
  },
  keeps: {
    pal: {
      lip: '#86C060',
      soil: '#A88A6E',
      stone_top: '#EEE6D6',
      stone_lit: '#DCD2BE',
      stone_side: '#BEB4A4',
      stone_shade: '#968EA0',
      stone_base: '#7A7290',
      moss: '#7CB44E',
      grass: '#8CC85E',
      grass2: '#A8D86A',
      grass_rim: '#C2E480',
      leaf_fall: ['#9AD06A', '#F2C14E', '#FFB7D0'],
      tree_pals: [
        [0.75, ['#3E9A58', '#5EB862', '#A0DC7E']],
        [0.25, ['#E08A9A', '#F2AABA', '#FFD6E0']],
      ],
    },
    ground: {
      slab: [220, 214, 200],
      slab_hi: [236, 232, 220],
      slab_lo: [196, 190, 178],
      joint: [150, 144, 136],
      dirt: [214, 204, 180],
      dirt_hi: [228, 220, 198],
      dirt_lo: [186, 176, 154],
    },
    rock: { kind: 'castle', red: '#FF5B4D', blue: '#2E8CFF' },
    decor: {
      pines: 0.0,
      mix: [
        [0.4, 'round'],
        [0.3, 'cypress'],
        [0.3, 'house'],
      ],
      features: ['keep_tower', 'keep_tower', 'keep_tower'],
      waterfall: true,
      bushes: true,
      density: 0.9,
    },
    gstyle: { castle: true },
    detail: { tuft: 1.3, flower: 0.18, pebble: 0.25, leaf: 0.3, extras: [] },
    field: ['castle'],
    liquid: { kind: 'water', z: -0.35, where: 'enclosed', minCells: 1 },
    ambient: { cols: ['#9AD06A', '#F2C14E', '#FFB7D0', '#FFFFFF'], n: 26, size: 0.06, speed: 0.7 },
  },
};

export function getHqTheme(name: string): HqThemeSpec {
  const ov = OVERRIDES[name] ?? OVERRIDES.meadow;
  return {
    name: OVERRIDES[name] ? name : 'meadow',
    pal: { ...BASE_SPEC.pal, ...(ov.pal || {}) },
    ground: { ...BASE_SPEC.ground, ...(ov.ground || {}) },
    rock: { ...BASE_SPEC.rock, ...(ov.rock || {}) },
    light: { ...BASE_SPEC.light, ...(ov.light || {}) },
    decor: { ...BASE_SPEC.decor, ...(ov.decor || {}) },
    gstyle: ov.gstyle ? { ...ov.gstyle } : {},
    detail: { ...BASE_SPEC.detail, ...(ov.detail || {}) },
    field: ov.field ? [...ov.field] : [...BASE_SPEC.field],
    ambient: ov.ambient === undefined ? BASE_SPEC.ambient : ov.ambient,
    liquid: ov.liquid ? { ...ov.liquid } : null,
  };
}
