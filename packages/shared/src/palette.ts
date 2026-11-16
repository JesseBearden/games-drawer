/**
 * Ten tank colours chosen to stay distinct against blue sky and purple ground.
 * hue/sat/light drive the sprite recolouring; css is used for names and chat.
 */
export interface TankColor {
  name: string;
  css: string;
  hue: number;
  sat: number;
  light: number;
}

export const TANK_COLORS: TankColor[] = [
  { name: 'Cyan', css: '#2fe6f0', hue: 184, sat: 0.85, light: 0.56 },
  { name: 'Red', css: '#ff5a5a', hue: 0, sat: 0.9, light: 0.6 },
  { name: 'Yellow', css: '#ffd23a', hue: 46, sat: 1, light: 0.6 },
  { name: 'Lime', css: '#8be33c', hue: 92, sat: 0.75, light: 0.55 },
  { name: 'Violet', css: '#b48cff', hue: 262, sat: 0.95, light: 0.72 },
  { name: 'Orange', css: '#ff9a2e', hue: 30, sat: 1, light: 0.58 },
  { name: 'Pink', css: '#ff6fc8', hue: 322, sat: 1, light: 0.7 },
  { name: 'White', css: '#f2f2ea', hue: 50, sat: 0.2, light: 0.93 },
  { name: 'Teal', css: '#2bd49a', hue: 158, sat: 0.7, light: 0.5 },
  { name: 'Blue', css: '#5b8dff', hue: 222, sat: 1, light: 0.67 },
];
