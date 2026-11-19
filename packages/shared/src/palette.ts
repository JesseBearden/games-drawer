/**
 * Ten player colours, as paper (DESIGN.md): cobalt, tomato, sunflower and grass first, then more.
 * hue/sat/light are the colour itself (they drive the tank sprites' recolouring); css is the same
 * colour for names and pointers.
 */
export interface TankColor {
  name: string;
  css: string;
  hue: number;
  sat: number;
  light: number;
}

export const TANK_COLORS: TankColor[] = [
  { name: 'Cobalt', css: '#1f4fc8', hue: 223, sat: 0.73, light: 0.45 },
  { name: 'Tomato', css: '#ef5943', hue: 8, sat: 0.84, light: 0.6 },
  { name: 'Sunflower', css: '#f6c12a', hue: 44, sat: 0.92, light: 0.56 },
  { name: 'Grass', css: '#4e9a5b', hue: 130, sat: 0.33, light: 0.45 },
  { name: 'Lilac', css: '#9a7fd1', hue: 260, sat: 0.47, light: 0.66 },
  { name: 'Orange', css: '#f2873e', hue: 24, sat: 0.87, light: 0.6 },
  { name: 'Pink', css: '#e2708d', hue: 345, sat: 0.66, light: 0.66 },
  { name: 'White', css: '#f2ede0', hue: 43, sat: 0.41, light: 0.91 },
  { name: 'Teal', css: '#2f9c8a', hue: 170, sat: 0.54, light: 0.4 },
  { name: 'Sky', css: '#4f97d6', hue: 208, sat: 0.62, light: 0.57 },
];
