export const orientationProtocol = 12;
export const orientationOffsetLimit = 15;

export interface DeviceOrientation {
  offsetDegrees: number;
}

export function isOrientationOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= orientationOffsetLimit && Number.isInteger(value * 2);
}

export function orientationPacket(offsetDegrees: number): string {
  if (!isOrientationOffset(offsetDegrees))
    throw new Error('Orientation offset must be from -15 to 15 degrees in half-degree steps.');
  return `^${Math.round(offsetDegrees * 10)}\n`;
}

export function orientationFromTenths(value: unknown): DeviceOrientation {
  if (!isOrientationTenths(value))
    throw new Error('The device sent an invalid orientation offset.');
  return {offsetDegrees: value / 10};
}

export function isOrientationTenths(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && isOrientationOffset(value / 10);
}

export function parseOrientationLine(line: string): DeviceOrientation {
  const match = /^ORIENTATION_SETTINGS offset_tenths=(-?\d+)$/.exec(line);
  if (!match) throw new Error('The device sent an invalid orientation settings response.');
  return orientationFromTenths(Number(match[1]));
}
