export interface RegionSelection { sequenceId: string; referenceFrameId: string; circle: Circle; hostName?: string }
export interface Circle { x: number; y: number; radiusPixels: number; innerRadiusPixels?: number; outerRadiusPixels?: number }
export interface Region { ra: number; dec: number; radiusArcsec: number; innerArcsec: number; outerArcsec: number }
