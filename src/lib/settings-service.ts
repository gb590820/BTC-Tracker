import { prisma } from './prisma';
import { AppSettings, defaultSettings, MainCurrency } from './types';
import { validateOnchainSettings } from './onchain/settings-validation';

export class SettingsService {
  private static settings: AppSettings | null = null;

  /**
   * Validate currency settings
   */
  private static validateCurrencySettings(currencySettings: Partial<AppSettings['currency']>): void {
    // Allow any supported currency as main currency
    const supportedCurrencies = ['USD', 'EUR', 'PLN', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SEK', 'NOK'];
    if (currencySettings.mainCurrency && !supportedCurrencies.includes(currencySettings.mainCurrency)) {
      throw new Error(`Invalid main currency: ${currencySettings.mainCurrency}. Main currency must be one of: ${supportedCurrencies.join(', ')}`);
    }
  }

  /**
   * Validate complete settings object
   */
  private static validateSettings(settings: Partial<Omit<AppSettings, 'id' | 'lastUpdated'>>): void {
    if (settings.currency) {
      this.validateCurrencySettings(settings.currency);
    }
  }

  /**
   * Load settings from database, or create default settings if none exist
   */
  static async loadSettings(): Promise<AppSettings> {
    try {
      const row = await prisma.appSettings.findFirst({
        orderBy: { id: 'desc' }
      });

      if (row) {
        try {
          const parsedSettings = JSON.parse(row.settingsData);
          const settings: AppSettings = {
            id: row.id,
            ...parsedSettings,
            // A settings blob written before on-chain watching existed has no
            // `onchain` key. Merging with the defaults keeps `settings.onchain`
            // defined instead of handing the scheduler an undefined object.
            onchain: {
              ...defaultSettings.onchain,
              ...(parsedSettings.onchain || {}),
            },
            lastUpdated: row.lastUpdated.toISOString(),
            version: row.version,
          };
          
          this.settings = settings;
          return settings;
        } catch (parseErr) {
          console.error('Error parsing settings JSON:', parseErr);
          // If parsing fails, create new default settings
          return this.createDefaultSettings();
        }
      } else {
        // No settings found, create default
        return this.createDefaultSettings();
      }
    } catch (error) {
      console.error('Error loading settings:', error);
      throw error;
    }
  }

  /**
   * Save settings to database
   */
  static async saveSettings(settings: Omit<AppSettings, 'id' | 'lastUpdated'>): Promise<AppSettings> {
    try {
      const settingsData = JSON.stringify({
        currency: settings.currency,
        priceData: settings.priceData,
        display: settings.display,
        notifications: settings.notifications,
        onchain: settings.onchain ?? defaultSettings.onchain,
      });

      const savedRecord = await prisma.appSettings.create({
        data: {
          settingsData: settingsData,
          version: settings.version,
        },
      });

      const savedSettings: AppSettings = {
        id: savedRecord.id,
        ...settings,
        lastUpdated: savedRecord.lastUpdated.toISOString(),
      };

      SettingsService.settings = savedSettings;
      return savedSettings;
    } catch (error) {
      console.error('Error saving settings:', error);
      throw error;
    }
  }

  /**
   * Update existing settings
   */
  static async updateSettings(
    settingsId: number,
    updates: Partial<Omit<AppSettings, 'id' | 'lastUpdated'>>
  ): Promise<AppSettings> {
    try {
      // Validate settings before updating
      this.validateSettings(updates);
      
      const currentSettings = await this.loadSettings();
      
      const updatedSettings = {
        ...currentSettings,
        ...updates,
        version: updates.version || currentSettings.version,
      };

      // The on-chain block is checked here rather than only in the route, so no
      // caller can persist an endpoint the scheduler would then call on a timer.
      const onchain = validateOnchainSettings(
        updatedSettings.onchain,
        currentSettings.onchain ?? defaultSettings.onchain
      );
      updatedSettings.onchain = onchain;

      const settingsData = JSON.stringify({
        currency: updatedSettings.currency,
        priceData: updatedSettings.priceData,
        display: updatedSettings.display,
        notifications: updatedSettings.notifications,
        onchain,
      });

      const savedRecord = await prisma.appSettings.upsert({
        where: { id: settingsId },
        update: {
          settingsData: settingsData,
          version: updatedSettings.version,
          lastUpdated: new Date(),
        },
        create: {
          id: settingsId,
          settingsData: settingsData,
          version: updatedSettings.version,
        },
      });

      const savedSettings: AppSettings = {
        ...updatedSettings,
        id: savedRecord.id,
        lastUpdated: savedRecord.lastUpdated.toISOString(),
      };

      SettingsService.settings = savedSettings;
      return savedSettings;
    } catch (error) {
      console.error('Error updating settings:', error);
      throw error;
    }
  }

  /**
   * Get current settings (cached or load from database)
   */
  static async getSettings(): Promise<AppSettings> {
    if (this.settings) {
      return this.settings;
    }
    return this.loadSettings();
  }

  /**
   * Create default settings in database
   */
  private static async createDefaultSettings(): Promise<AppSettings> {
    console.log('Creating default settings...');
    return this.saveSettings(defaultSettings);
  }

  /**
   * Reset settings to default
   */
  static async resetToDefaults(): Promise<AppSettings> {
    const currentSettings = await this.loadSettings();
    return this.updateSettings(currentSettings.id, defaultSettings);
  }

  /**
   * Get specific setting category
   */
  static async getCurrencySettings() {
    const settings = await this.getSettings();
    return settings.currency;
  }

  static async getPriceDataSettings() {
    const settings = await this.getSettings();
    return settings.priceData;
  }

  static async getDisplaySettings() {
    const settings = await this.getSettings();
    return settings.display;
  }

  static async getNotificationSettings() {
    const settings = await this.getSettings();
    return settings.notifications;
  }

  /**
   * Update specific setting category
   */
  static async updateCurrencySettings(currencySettings: Partial<AppSettings['currency']>) {
    // Validate currency settings before updating
    this.validateCurrencySettings(currencySettings);
    
    const settings = await this.getSettings();
    return this.updateSettings(settings.id, {
      currency: { ...settings.currency, ...currencySettings }
    });
  }

  static async updatePriceDataSettings(priceDataSettings: Partial<AppSettings['priceData']>) {
    const settings = await this.getSettings();
    return this.updateSettings(settings.id, {
      priceData: { ...settings.priceData, ...priceDataSettings }
    });
  }

  static async updateDisplaySettings(displaySettings: Partial<AppSettings['display']>) {
    const settings = await this.getSettings();
    return this.updateSettings(settings.id, {
      display: { ...settings.display, ...displaySettings }
    });
  }

  static async updateNotificationSettings(notificationSettings: Partial<AppSettings['notifications']>) {
    const settings = await this.getSettings();
    return this.updateSettings(settings.id, {
      notifications: { ...settings.notifications, ...notificationSettings }
    });
  }
} 