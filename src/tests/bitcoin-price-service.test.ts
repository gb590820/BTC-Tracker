/**
 * Bitcoin Price Service — acquisitions pool tests.
 *
 * The "Total invested" figure is built from everything the user put money into:
 * BUY rows (actual fiat paid) plus on-chain TRANSFER_IN rows (valued at the
 * block-day close by the on-chain importer). The backfill guarantees a stored
 * price exists even for days older than the ~365-day local window.
 */

import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from './test-db'
import { createTestUser, createTestTransaction } from './test-helpers'
import { BitcoinPriceService } from '../lib/bitcoin-price-service'

jest.mock('../lib/yahoo-finance-service', () => ({
  YahooFinanceService: {
    fetchHistoricalData: jest.fn(),
    saveHistoricalData: jest.fn()
  }
}))

import { YahooFinanceService } from '../lib/yahoo-finance-service'

const mockFetchHistoricalData = YahooFinanceService.fetchHistoricalData as jest.Mock
const mockSaveHistoricalData = YahooFinanceService.saveHistoricalData as jest.Mock

/**
 * Persist the portfolio summary in the summary table and return the stored row.
 */
async function calculatePortfolio(userId: number) {
  await BitcoinPriceService.calculateAndStorePortfolioSummary(userId, 100000)
  return await testDb.portfolioSummary.findUnique({ where: { userId } })
}

describe('BitcoinPriceService acquisitions pool', () => {
  let testUser: any

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    testUser = await createTestUser({ email: 'pool@example.com' })

    mockFetchHistoricalData.mockReset()
    mockSaveHistoricalData.mockReset()
    BitcoinPriceService.clearCache()
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('counts an on-chain TRANSFER_IN valued at block-day close in Total invested', async () => {
    await createTestTransaction({
      userId: testUser.id,
      type: 'BUY',
      btcAmount: 0.1,
      originalPricePerBtc: 50000,
      originalTotalAmount: 5000
    })
    await createTestTransaction({
      userId: testUser.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000
    })

    const summary = await calculatePortfolio(testUser.id)

    expect(summary?.totalBtc).toBeCloseTo(0.6)
    expect(summary?.totalInvested).toBeCloseTo(25000)
    expect(summary?.averageBuyPrice).toBeCloseTo(25000 / 0.6)
  })

  it('excludes on-chain rows without a stored cost basis (originalTotalAmount = 0)', async () => {
    await createTestTransaction({
      userId: testUser.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 0,
      originalTotalAmount: 0
    })

    const summary = await calculatePortfolio(testUser.id)

    expect(summary?.totalBtc).toBeCloseTo(0.5)
    expect(summary?.totalInvested).toBe(0)
    expect(summary?.averageBuyPrice).toBe(0)
  })

  it('keeps manual/internal transfers out of Total invested (no double count)', async () => {
    await createTestTransaction({
      userId: testUser.id,
      type: 'BUY',
      btcAmount: 0.1,
      originalPricePerBtc: 50000,
      originalTotalAmount: 5000
    })
    await createTestTransaction({
      userId: testUser.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'manual',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000
    })

    const summary = await calculatePortfolio(testUser.id)

    expect(summary?.totalBtc).toBeCloseTo(0.6)
    expect(summary?.totalInvested).toBeCloseTo(5000)
    expect(summary?.averageBuyPrice).toBeCloseTo(50000)
  })

  it('backfills the daily history from Yahoo when the date is older than the local window', async () => {
    // A local price window exists but does not reach back to 2020-06-01.
    await testDb.bitcoinPriceHistory.create({
      data: {
        date: '2020-06-10',
        openUsd: 10000,
        highUsd: 10100,
        lowUsd: 9900,
        closeUsd: 10000,
      },
    })

    mockFetchHistoricalData.mockResolvedValue([
      {
        date: '2020-06-01',
        open_usd: 9400,
        high_usd: 9600,
        low_usd: 9350,
        close_usd: 9500.5,
        volume: 100
      }
    ])
    mockSaveHistoricalData.mockImplementation(async (rows: any[]) => {
      for (const row of rows) {
        await testDb.bitcoinPriceHistory.upsert({
          where: { date: row.date },
          update: {
            openUsd: row.open_usd,
            highUsd: row.high_usd,
            lowUsd: row.low_usd,
            closeUsd: row.close_usd,
            volume: row.volume
          },
          create: {
            date: row.date,
            openUsd: row.open_usd,
            highUsd: row.high_usd,
            lowUsd: row.low_usd,
            closeUsd: row.close_usd,
            volume: row.volume
          }
        })
      }
    })

    const price = await BitcoinPriceService.getOrFetchPriceForDate('2020-06-01')
    expect(price).toBeCloseTo(9500.5)

    const cached = await BitcoinPriceService.getOrFetchPriceForDate('2020-06-02')
    expect(cached).toBeCloseTo(9500.5)

    expect(mockFetchHistoricalData).toHaveBeenCalledTimes(1)
    expect(mockSaveHistoricalData).toHaveBeenCalledTimes(1)
  })

  it('skips the backfill (and the network) when no local history exists', async () => {
    const price = await BitcoinPriceService.getOrFetchPriceForDate('2020-06-01')

    expect(price).toBeNull()
    expect(mockFetchHistoricalData).not.toHaveBeenCalled()
    expect(mockSaveHistoricalData).not.toHaveBeenCalled()
  })
})