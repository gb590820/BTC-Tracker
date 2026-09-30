/**
 * Portfolio Metrics API — on-chain acquisitions.
 *
 * The "Investment" widget (PortfolioSummaryWidget) and the sidebar read
 * `/api/portfolio-metrics`. On-chain receives carry an inferred cost basis
 * (block-day close) and must count in Total invested, while manual/internal
 * transfers must stay out of it.
 */

import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from '../test-db'
import { createTestUserWithToken, createTestTransaction } from '../test-helpers'
import { NextRequest } from 'next/server'
import { GET as portfolioMetricsGET } from '../../app/api/portfolio-metrics/route'

const createMockRequest = (headers: HeadersInit | undefined, detailed = false) => ({
  method: 'GET',
  url: 'http://localhost/api/portfolio-metrics',
  headers: new Headers(headers || {}),
  json: async () => ({}),
  nextUrl: {
    pathname: '/api/portfolio-metrics',
    searchParams: new URLSearchParams(detailed ? 'detailed=true' : '')
  }
} as unknown as NextRequest)

describe('Portfolio Metrics API — on-chain acquisitions', () => {
  let userId: number
  let authHeaders: { Authorization: string }

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    const { user, authHeaders: headers } = await createTestUserWithToken({
      email: 'metrics@example.com',
    })
    userId = user.id
    authHeaders = headers

    // Seed a current price so getCurrentPrice() does not reach Yahoo.
    await testDb.bitcoinCurrentPrice.create({
      data: { priceUsd: 100000, timestamp: new Date().toISOString(), source: 'test' },
    })
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('counts on-chain receives in Total invested', async () => {
    await createTestTransaction({
      userId,
      type: 'BUY',
      btcAmount: 0.1,
      originalPricePerBtc: 50000,
      originalTotalAmount: 5000,
    })
    await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await portfolioMetricsGET(createMockRequest(authHeaders))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.totalInvested).toBeCloseTo(25000)
  })

  it('keeps manual/internal transfers out of Total invested', async () => {
    await createTestTransaction({
      userId,
      type: 'BUY',
      btcAmount: 0.1,
      originalPricePerBtc: 50000,
      originalTotalAmount: 5000,
    })
    await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'manual',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await portfolioMetricsGET(createMockRequest(authHeaders))
    const body = await response.json()

    expect(body.data.totalInvested).toBeCloseTo(5000)
  })

  it('puts on-chain receives in the monthly buys bucket of the detailed breakdown', async () => {
    await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
      transactionDate: new Date('2024-06-15'),
    })

    const response = await portfolioMetricsGET(createMockRequest(authHeaders, true))
    const body = await response.json()

    expect(body.success).toBe(true)
    const month = body.data.monthlyBreakdown?.find((m: any) => m.month === '2024-06')
    expect(month).toBeDefined()
    expect(month.buys).toBe(1)
    expect(month.totalBought).toBeCloseTo(0.5)
    expect(month.sells).toBe(0)
  })
})