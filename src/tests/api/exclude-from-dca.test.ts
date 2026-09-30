/**
 * Exclude-from-DCA route: revert a promoted on-chain receive back to a
 * TRANSFER (mistake recovery) while keeping the inferred cost basis.
 */

import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from '../test-db'
import { createTestUserWithToken, createTestTransaction } from '../test-helpers'
import { NextRequest } from 'next/server'
import {
  POST as includeInDcaPOST,
} from '../../app/api/transactions/[id]/include-in-dca/route'
import { POST as excludeFromDcaPOST } from '../../app/api/transactions/[id]/exclude-from-dca/route'

const createMockRequest = (headers: HeadersInit | undefined) => ({
  method: 'POST',
  url: 'http://localhost/api/transactions/1/exclude-from-dca',
  headers: new Headers(headers || {}),
  json: async () => ({}),
  nextUrl: {
    pathname: '/api/transactions/1/exclude-from-dca',
    searchParams: new URLSearchParams()
  }
} as unknown as NextRequest)

describe('POST /api/transactions/[id]/exclude-from-dca', () => {
  let userId: number
  let authHeaders: { Authorization: string }

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    const { user, authHeaders: headers } = await createTestUserWithToken({
      email: 'excludedca@example.com',
    })
    userId = user.id
    authHeaders = headers
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('reverts a promoted on-chain receive to TRANSFER and keeps its cost basis', async () => {
    const tx = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    await includeInDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    const response = await excludeFromDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)

    const updated = await testDb.bitcoinTransaction.findUnique({ where: { id: tx.id } })
    expect(updated?.type).toBe('TRANSFER')
    expect(updated?.originalTotalAmount).toBe(20000)
    expect(updated?.originalPricePerBtc).toBe(40000)
  })

  it('rejects a transaction that was never promoted to BUY', async () => {
    const tx = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await excludeFromDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    expect(response.status).toBe(400)
  })

  it('returns 404 for a transaction owned by another user', async () => {
    const other = await createTestUserWithToken({ email: 'other-exclude@example.com' })
    const tx = await createTestTransaction({
      userId: other.user.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    await includeInDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    const response = await excludeFromDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    expect(response.status).toBe(404)
  })
})