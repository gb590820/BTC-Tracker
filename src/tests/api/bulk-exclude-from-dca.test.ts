import { testDb, setupTestDatabase, cleanTestDatabase, seedTestDatabase } from '../test-db'
import { createTestUserWithToken, createTestTransaction } from '../test-helpers'
import { NextRequest } from 'next/server'
import { POST as bulkExcludeFromDcaPOST } from '../../app/api/transactions/bulk-exclude-from-dca/route'

const createMockRequest = (headers: HeadersInit | undefined, ids: unknown) => ({
  method: 'POST',
  url: 'http://localhost/api/transactions/bulk-exclude-from-dca',
  headers: new Headers(headers || {}),
  json: async () => ({ ids }),
  nextUrl: {
    pathname: '/api/transactions/bulk-exclude-from-dca',
    searchParams: new URLSearchParams(),
  },
} as unknown as NextRequest)

describe('POST /api/transactions/bulk-exclude-from-dca', () => {
  let userId: number
  let authHeaders: { Authorization: string }

  beforeAll(async () => {
    await setupTestDatabase()
  }, 30000)

  beforeEach(async () => {
    await cleanTestDatabase()
    await seedTestDatabase()

    const { user, authHeaders: headers } = await createTestUserWithToken({
      email: 'bulkexcludedca@example.com',
    })
    userId = user.id
    authHeaders = headers
  })

  afterAll(async () => {
    await testDb.$disconnect()
  })

  it('excludes promoted on-chain receives and skips other rows', async () => {
    const promoted = await createTestTransaction({
      userId,
      type: 'BUY',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.2,
      originalPricePerBtc: 40000,
      originalTotalAmount: 8000,
    })
    const manual = await createTestTransaction({
      userId,
      type: 'BUY',
      source: 'manual',
      btcAmount: 0.3,
      originalTotalAmount: 12000,
    })

    const response = await bulkExcludeFromDcaPOST(
      createMockRequest(authHeaders, [promoted.id, manual.id])
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.excluded).toBe(1)
    expect(body.data.skipped).toBe(1)
    expect(body.data.totalSelected).toBe(2)

    const promotedRow = await testDb.bitcoinTransaction.findUnique({ where: { id: promoted.id } })
    const manualRow = await testDb.bitcoinTransaction.findUnique({ where: { id: manual.id } })
    expect(promotedRow?.type).toBe('TRANSFER')
    expect(manualRow?.type).toBe('BUY')
  })

  it('returns 200 with excluded 0 when nothing qualifies', async () => {
    const transfer = await createTestTransaction({
      userId,
      type: 'TRANSFER',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalTotalAmount: 20000,
    })

    const response = await bulkExcludeFromDcaPOST(createMockRequest(authHeaders, [transfer.id]))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.excluded).toBe(0)
    expect(body.data.skipped).toBe(1)
  })

  it('rejects an empty or invalid ids array', async () => {
    expect((await bulkExcludeFromDcaPOST(createMockRequest(authHeaders, []))).status).toBe(400)
    expect((await bulkExcludeFromDcaPOST(createMockRequest(authHeaders, [1, 'x']))).status).toBe(400)
    expect((await bulkExcludeFromDcaPOST(createMockRequest(authHeaders, undefined))).status).toBe(400)
  })

  it('ignores ids owned by another user', async () => {
    const other = await createTestUserWithToken({ email: 'other-bulk-exclude@example.com' })
    const transaction = await createTestTransaction({
      userId: other.user.id,
      type: 'BUY',
      transferType: 'TRANSFER_IN',
      source: 'onchain',
      btcAmount: 0.5,
      originalPricePerBtc: 40000,
      originalTotalAmount: 20000,
    })

    const response = await bulkExcludeFromDcaPOST(createMockRequest(authHeaders, [transaction.id]))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.excluded).toBe(0)
    expect(body.data.skipped).toBe(0)
  })
})
