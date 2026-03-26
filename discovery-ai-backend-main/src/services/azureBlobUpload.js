import { BlobServiceClient } from '@azure/storage-blob'

function getConnectionString() {
  return (process.env.AZURE_STORAGE_CONNECTION_STRING || '').trim()
}

export function isAzureConfigured() {
  return !!getConnectionString()
}

/**
 * userId/year/month/day/screenshots/userId_screenshotId.jpg (UTC date parts)
 */
export function buildScreenshotBlobPath(userId, screenshotId, date = new Date()) {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const safeUser = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_')
  const safeShot = String(screenshotId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')
  const filename = `${safeUser}_${safeShot}.jpg`
  return `${safeUser}/${y}/${m}/${d}/screenshots/${filename}`
}

/**
 * @param {Buffer} buffer — JPEG bytes
 * @returns {{ imageUrl: string, azureBlobPath: string, azureContainer: string, storageProvider: string }}
 */
export async function uploadScreenshotBuffer(buffer, blobPath) {
  const conn = getConnectionString()
  if (!conn) throw new Error('Azure storage connection string is not available')
  const containerName = (process.env.AZURE_STORAGE_CONTAINER || 'screenshots').trim()
  const service = BlobServiceClient.fromConnectionString(conn)
  const container = service.getContainerClient(containerName)
  await container.createIfNotExists()
  const blockBlob = container.getBlockBlobClient(blobPath)
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: 'image/jpeg' }
  })
  return {
    imageUrl: blockBlob.url,
    azureBlobPath: blobPath,
    azureContainer: containerName,
    storageProvider: 'azure'
  }
}
