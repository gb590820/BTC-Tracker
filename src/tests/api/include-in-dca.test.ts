/**
 * Include-in-DCA route: one-click promotion of a scanned on-chain receive to a
 * BUY so it joins the DCA analysis, keeping the inferred cost basis.
 */

import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from '../test-db'
import { createTestUserWithToken, createTestTransaction } from '../test-helpers'
import { NextRequest } from 'next/server'
import { POST as includeInDcaPOST } from '../../app/api/transactions/[id]/include-in-dca/route'

const createMockRequest = (headers: HeadersInit | undefined) => ({
  method: 'POST',
  url: 'http://localhost/api/transactions/1/include-in-dca',
  headers: new Headers(headers || {}),
  json: async () => ({}),
  nextUrl: {
    pathname: '/api/transactions/1/include-in-dca',
    searchParams: new URLSearchParams()
  }
} as unknown as NextRequest)

describe('POST /api/transactions/[id]/include-in-dca', () => {
  let userId: number
  let authHeaders: { Authorization: string }

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    const { user, authHeaders: headers } = await createTestUserWithToken({
      email: 'includedca@example.com',
    })
    userId = user.id
    authHeaders = headers
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('promotes an eligible on-chain receive to BUY and keeps its cost basis', async () => {
    const tx = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await includeInDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)

    const updated = await testDb.bitcoinTransaction.findUnique({ where: { id: tx.id } })
    expect(updated?.type).toBe('BUY')
    expect(updated?.originalTotalAmount).toBe(20000)
    expect(updated?.originalPricePerBtc).toBe(40000)
  })

  it('rejects a manual/internal transfer', async () => {
    const tx = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'manual',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await includeInDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    expect(response.status).toBe(400)
  })

  it('returns 404 for a transaction owned by another user', async () => {
    const other = await createTestUserWithToken({ email: 'other-include@example.com' })
    const tx = await createTestTransaction({
      userId: other.user.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await includeInDcaPOST(createMockRequest(authHeaders), {
      params: Promise.resolve({ id: String(tx.id) }),
    })

    expect(response.status).toBe(404)
  })
})