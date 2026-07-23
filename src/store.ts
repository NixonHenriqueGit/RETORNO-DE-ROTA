// Legacy store placeholder - localStorage & BroadcastChannel removed completely per Firestore migration.
import { User, Driver, Vehicle, Product, ActiveAsset, AuditSession, ReturnForecast, FiscalAlert, ImportedRoute, Vale } from './types';

export class AppStore {
  static getUsers(): User[] { return []; }
  static setUsers(_users: User[]): void {}
  static getDrivers(): Driver[] { return []; }
  static setDrivers(_drivers: Driver[]): void {}
  static getVehicles(): Vehicle[] { return []; }
  static setVehicles(_vehicles: Vehicle[]): void {}
  static getProducts(): Product[] { return []; }
  static setProducts(_products: Product[]): void {}
  static getActiveAssets(): ActiveAsset[] { return []; }
  static setActiveAssets(_assets: ActiveAsset[]): void {}
  static getAudits(): AuditSession[] { return []; }
  static setAudits(_audits: AuditSession[]): void {}
  static getReturnForecasts(): ReturnForecast[] { return []; }
  static setReturnForecasts(_forecasts: ReturnForecast[]): void {}
  static getFiscalAlerts(): FiscalAlert[] { return []; }
  static setFiscalAlerts(_alerts: FiscalAlert[]): void {}
  static getImportedRoutes(): ImportedRoute[] { return []; }
  static setImportedRoutes(_routes: ImportedRoute[]): void {}
  static getVales(): Vale[] { return []; }
  static setVales(_vales: Vale[]): void {}
  static getAuditLogs(): any[] { return []; }
  static setAuditLogs(_logs: any[]): void {}
  static getCustomManual(): string { return ''; }
  static setCustomManual(_html: string): void {}
}
