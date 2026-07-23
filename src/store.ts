import { User, Driver, Vehicle, Product, ActiveAsset, AuditSession, AuditStatus, AuditItem, AuditAssetItem, ReturnForecast, FiscalAlert, ImportedRoute, Vale } from './types';
import { DEFAULT_USERS, DEFAULT_DRIVERS, DEFAULT_VEHICLES, DEFAULT_PRODUCTS, DEFAULT_ACTIVE_ASSETS } from './data';

// LocalStorage helpers
const syncChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window 
  ? new BroadcastChannel('logiroute_realtime_sync') 
  : null;

const getStored = <T>(key: string, fallback: T): T => {
  const data = localStorage.getItem(key);
  if (!data) return fallback;
  try {
    return JSON.parse(data) as T;
  } catch (e) {
    return fallback;
  }
};

const setStored = <T>(key: string, val: T): void => {
  localStorage.setItem(key, JSON.stringify(val));
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'SYNC_KEY', key });
    } catch (e) {
      console.warn('BroadcastChannel error:', e);
    }
  }
};

// Initial state initialization
export class AppStore {
  static getUsers(): User[] {
    const stored = getStored<User[]>('logiroute_users', DEFAULT_USERS);
    if (!stored || stored.length === 0) return DEFAULT_USERS;
    
    // Ensure all DEFAULT_USERS exist in stored list (matched by username or id)
    const userMap = new Map<string, User>();
    DEFAULT_USERS.forEach(u => {
      if (u && (u.username || u.id)) {
        const key = (u.username || u.id).toString().toLowerCase();
        userMap.set(key, u);
      }
    });
    stored.forEach(u => {
      if (u && (u.username || u.id)) {
        const key = (u.username || u.id).toString().toLowerCase();
        const existing = userMap.get(key);
        userMap.set(key, {
          ...existing,
          ...u,
          password: u.password || existing?.password || '123'
        });
      }
    });
    return Array.from(userMap.values());
  }

  static setUsers(users: User[]): void {
    setStored('logiroute_users', users);
  }

  static getDrivers(): Driver[] {
    return getStored<Driver[]>('logiroute_drivers', DEFAULT_DRIVERS);
  }

  static setDrivers(drivers: Driver[]): void {
    setStored('logiroute_drivers', drivers);
  }

  static getVehicles(): Vehicle[] {
    return getStored<Vehicle[]>('logiroute_vehicles', DEFAULT_VEHICLES);
  }

  static setVehicles(vehicles: Vehicle[]): void {
    setStored('logiroute_vehicles', vehicles);
  }

  static getProducts(): Product[] {
    return getStored<Product[]>('logiroute_products', DEFAULT_PRODUCTS);
  }

  static setProducts(products: Product[]): void {
    setStored('logiroute_products', products);
  }

  static getActiveAssets(): ActiveAsset[] {
    return getStored<ActiveAsset[]>('logiroute_assets', DEFAULT_ACTIVE_ASSETS);
  }

  static setActiveAssets(assets: ActiveAsset[]): void {
    setStored('logiroute_assets', assets);
  }

  static getAudits(): AuditSession[] {
    const fallback: AuditSession[] = [
      {
        id: 'aud_1',
        routeMap: 'MAPA-042',
        plate: 'TOU7F39',
        driverId: 'G1034',
        helperId: 'G1037',
        arrivalKm: 145260,
        arrivalDate: new Date().toISOString().split('T')[0],
        startTime: new Date(Date.now() - 3600000).toISOString(),
        endTime: new Date(Date.now() - 3000000).toISOString(),
        status: 'finalizado_ok',
        conferenteId: 'usr_1',
        auxiliarId: 'usr_2',
        items: [
          { productCode: '14550', productDescription: 'COLORADO APPIA ONE WAY 600ML CX C-12 ARTE', cost: 133.46, physicalQty: 10, fiscalQty: 10 },
          { productCode: '34432', productDescription: 'RED BULL TROPICAL BR LATA 473ML CX C 12', cost: 140.44, physicalQty: 5, fiscalQty: 5 }
        ],
        assets: [
          { assetId: '899599', assetName: 'GARRAFEIRA 600ML', cost: 31.16, physicalQty: 24, fiscalQty: 24 },
          { assetId: 'pal_pbr', assetName: 'PALETE PBR', cost: 120.0, physicalQty: 2, fiscalQty: 2 }
        ],
        history: [
          { timestamp: new Date(Date.now() - 3600000).toISOString(), action: 'Conferência Iniciada', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 3000000).toISOString(), action: 'Conferência Física Salva', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 2500000).toISOString(), action: 'Aferição Fiscal Finalizada - OK', user: 'Bruno Fiscal' }
        ],
        reconciliationNotes: 'Conferência perfeita. Tudo em conformidade.'
      },
      {
        id: 'aud_2',
        routeMap: 'MAPA-108',
        plate: 'TOZ8B20',
        driverId: 'G1049',
        helperId: 'G1058',
        arrivalKm: 89310,
        arrivalDate: new Date().toISOString().split('T')[0],
        startTime: new Date(Date.now() - 2800000).toISOString(),
        endTime: new Date(Date.now() - 2000000).toISOString(),
        status: 'finalizado_divergente',
        conferenteId: 'usr_1',
        auxiliarId: 'usr_2',
        items: [
          { productCode: '21632', productDescription: 'SPATEN N LN 355ML SIXPACK SH C/24', cost: 94.58, physicalQty: 12, fiscalQty: 15 }, // Falta 3
          { productCode: '17808', productDescription: 'BUDWEISER OW 330ML CX C/24', cost: 90.67, physicalQty: 8, fiscalQty: 8 }
        ],
        assets: [
          { assetId: '899599', assetName: 'GARRAFEIRA 600ML', cost: 31.16, physicalQty: 10, fiscalQty: 10 },
          { assetId: 'chapatex', assetName: 'CHAPATEX', cost: 18.0, physicalQty: 15, fiscalQty: 12 } // Sobra 3
        ],
        history: [
          { timestamp: new Date(Date.now() - 2800000).toISOString(), action: 'Conferência Iniciada', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 2000000).toISOString(), action: 'Conferência Física Salva', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 1500000).toISOString(), action: 'Reconferência Solicitada', user: 'Bruno Fiscal', details: 'Divergência detectada na Spaten e Chapatex.' },
          { timestamp: new Date(Date.now() - 1200000).toISOString(), action: 'Reconferência Finalizada - Persistiu divergência', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 1000000).toISOString(), action: 'Aferição Fiscal Finalizada com Divergência', user: 'Bruno Fiscal' }
        ],
        reconciliationNotes: 'Divergências de 3 caixas de Spaten (Falta) e 3 chapatex (Sobra). Motorista ciente, assinou termo.'
      },
      {
        id: 'aud_3',
        routeMap: 'MAPA-077',
        plate: 'SLB3J76',
        driverId: 'G1019',
        helperId: 'G1066',
        arrivalKm: 210550,
        arrivalDate: new Date().toISOString().split('T')[0],
        startTime: new Date(Date.now() - 1200000).toISOString(),
        endTime: new Date(Date.now() - 600000).toISOString(),
        status: 'conferido_fisico',
        conferenteId: 'usr_1',
        items: [
          { productCode: '988', productDescription: 'BRAHMA CHOPP 600ML GFA VD', cost: 52.23, physicalQty: 40 },
          { productCode: '982', description: 'SKOL 600ML GFA VD', cost: 53.35, physicalQty: 30 } as any
        ],
        assets: [
          { assetId: '899599', assetName: 'GARRAFEIRA 600ML', cost: 31.16, physicalQty: 70 },
          { assetId: 'pal_pbr', assetName: 'PALETE PBR', cost: 120.0, physicalQty: 4 }
        ],
        history: [
          { timestamp: new Date(Date.now() - 1200000).toISOString(), action: 'Conferência Iniciada', user: 'Alice Conferente' },
          { timestamp: new Date(Date.now() - 600000).toISOString(), action: 'Conferência Física Salva - Aguardando Fiscal', user: 'Alice Conferente' }
        ]
      }
    ];

    return getStored<AuditSession[]>('logiroute_audits', fallback);
  }

  static setAudits(audits: AuditSession[]): void {
    setStored('logiroute_audits', audits);
  }

  static getReturnForecasts(): ReturnForecast[] {
    const fallback: ReturnForecast[] = [
      {
        id: 'fc_1',
        plate: 'TOZ8B50',
        driverName: 'JOSE HONORIO DA SILVA',
        routeMap: 'MAPA-212',
        eta: '14:45',
        status: 'em_rota',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'fc_2',
        plate: 'SLB4A26',
        driverName: 'CESARIO FERREIRA DE VASCONCELOS',
        routeMap: 'MAPA-304',
        eta: '15:15',
        status: 'chegando',
        updatedAt: new Date().toISOString()
      },
      {
        id: 'fc_3',
        plate: 'RLW0C17',
        driverName: 'JOSENILSON INACIO DE ANDRADE',
        routeMap: 'MAPA-150',
        eta: '16:00',
        status: 'em_rota',
        updatedAt: new Date().toISOString()
      }
    ];
    return getStored<ReturnForecast[]>('logiroute_forecasts', fallback);
  }

  static setReturnForecasts(forecasts: ReturnForecast[]): void {
    setStored('logiroute_forecasts', forecasts);
  }

  static getFiscalAlerts(): FiscalAlert[] {
    const fallback: FiscalAlert[] = [
      {
        id: 'al_1',
        routeMap: 'MAPA-042',
        plate: 'TOU7F39',
        status: 'finalizado_ok',
        timestamp: new Date(Date.now() - 2500000).toISOString(),
        read: false
      }
    ];
    return getStored<FiscalAlert[]>('logiroute_alerts', fallback);
  }

  static setFiscalAlerts(alerts: FiscalAlert[]): void {
    setStored('logiroute_alerts', alerts);
  }

  static getImportedRoutes(): ImportedRoute[] {
    return getStored<ImportedRoute[]>('logiroute_imported_routes', []);
  }

  static setImportedRoutes(routes: ImportedRoute[]): void {
    setStored('logiroute_imported_routes', routes);
  }

  static getVales(): Vale[] {
    const fallback: Vale[] = [
      {
        id: 'val_1',
        auditId: 'aud_2',
        routeMap: 'MAPA-108',
        colaboradorId: 'G1049',
        colaboradorName: 'VALDKLEBER DE SOUZA ALEXANDRE',
        colaboradorRole: 'MOTORISTA',
        valor: 283.74,
        descricao: 'Falta de 3 cx de SPATEN N LN 355ML SIXPACK SH C/24 no mapa MAPA-108',
        dataGeracao: new Date().toISOString().split('T')[0],
        status: 'PENDENTE_ASSINATURA',
        observacao: 'Falta confirmada na recontagem fiscal'
      }
    ];
    return getStored<Vale[]>('logiroute_vales', fallback);
  }

  static setVales(vales: Vale[]): void {
    setStored('logiroute_vales', vales);
  }

  static getAuditLogs(): any[] {
    return getStored<any[]>('logiroute_audit_logs', []);
  }

  static setAuditLogs(logs: any[]): void {
    setStored('logiroute_audit_logs', logs);
  }

  static getCustomManual(): string {
    return getStored<string>('logiroute_custom_manual', '');
  }

  static setCustomManual(html: string): void {
    setStored('logiroute_custom_manual', html);
  }
}

