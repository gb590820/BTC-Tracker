/**
 * Bulk-include-in-DCA route: promote every eligible on-chain receive among a
 * selection to BUY, skipping (without failing) rows that do not qualify.
 */

import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from '../test-db'
import { createTestUserWithToken, createTestTransaction } from '../test-helpers'
import { NextRequest } from 'next/server'
import { POST as bulkIncludeInDcaPOST } from '../../app/api/transactions/bulk-include-in-dca/route'

const createMockRequest = (headers: HeadersInit | undefined, ids: unknown) => ({
  method: 'POST',
  url: 'http://localhost/api/transactions/bulk-include-in-dca',
  headers: new Headers(headers || {}),
  json: async () => ({ ids }),
  nextUrl: {
    pathname: '/api/transactions/bulk-include-in-dca',
    searchParams: new URLSearchParams()
  }
} as unknown as NextRequest)

describe('POST /api/transactions/bulk-include-in-dca', () => {
  let userId: number
  let authHeaders: { Authorization: string }

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    const { user, authHeaders: headers } = await createTestUserWithToken({
      email: 'bulkincludedca@example.com',
    })
    userId = user.id
    authHeaders = headers
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('includes eligible on-chain receives and skips manual ones', async () => {
    const onchain1 = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.2,
      originalPricePerBtc: 40000,
      originalTotalAmount: 8000,
    })
    const onchain2 = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.3,
      originalPricePerBtc: 42000,
      originalTotalAmount: 12600,
    })
    const manual = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'manual',
      btcAmount: 0.5,
      originalTotalAmount: 5000,
    })

    const response = await bulkIncludeInDcaPOST(
      createMockRequest(authHeaders, [onchain1.id, onchain2.id, manual.id])
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.included).toBe(2)
    expect(body.data.skipped).toBe(1)
    expect(body.data.totalSelected).toBe(3)

    const t1 = await testDb.bitcoinTransaction.findUnique({ where: { id: onchain1.id } })
    const t2 = await testDb.bitcoinTransaction.findUnique({ where: { id: onchain2.id } })
    const tm = await testDb.bitcoinTransaction.findUnique({ where: { id: manual.id } })
    expect(t1?.type).toBe('BUY')
    expect(t2?.type).toBe('BUY')
    expect(tm?.type).toBe('TRANSFER')
  })

  it('returns 200 with included 0 when nothing is eligible', async () => {
    const manual = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'manual',
      btcAmount: 0.5,
      originalTotalAmount: 5000,
    })

    const response = await bulkIncludeInDcaPOST(createMockRequest(authHeaders, [manual.id]))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.included).toBe(0)
    expect(body.data.skipped).toBe(1)
  })

  it('rejects an empty or invalid ids array', async () => {
    const empty = await bulkIncludeInDcaPOST(createMockRequest(authHeaders, []))
    expect(empty.status).toBe(400)

    const invalid = await bulkIncludeInDcaPOST(createMockRequest(authHeaders, [1, 'x']))
    expect(invalid.status).toBe(400)

    const missing = await bulkIncludeInDcaPOST(createMockRequest(authHeaders, undefined))
    expect(missing.status).toBe(400)
  })

  it('ignores ids owned by another user', async () => {
    const other = await createTestUserWithToken({ email: 'other-bulk@example.com' })
    const tx = await createTestTransaction({
      userId: other.user.id,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await bulkIncludeInDcaPOST(createMockRequest(authHeaders, [tx.id]))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.included).toBe(0)
    expect(body.data.skipped).toBe(0)
  })
})