import { HttpResponse } from "../../utils/http-response.mjs"
import { withRateLimit } from "../../utils/rate-limit.js"
import { registerInstall } from "../../utils/install-registry.js"
import { Buffer } from "node:buffer"
import { extractText, getDocumentProxy } from "unpdf"

const MAX_PDF_BYTES = 5 * 1024 * 1024
const MAX_ENCODED_LENGTH = Math.ceil(MAX_PDF_BYTES * 4) / 3
const MAX_PDF_PAGES = 2
const MAX_EXTRACTED_TEXT_SIZE = 100000

export const handler = async (event) => {
    const method = event.requestContext.http.method;
    const path = event.rawPath

    if (method !== 'POST')
        return HttpResponse({ statusCode: 405, body: { message: 'Method not allowed' } });

    if (path !== '/parse-pdf')
        return HttpResponse({ statusCode: 404, body: { message: "Error. Not found!" } })

    if (!event.body || !event.isBase64Encoded)
        return HttpResponse({ statusCode: 400, body: { message: 'Send the PDF as the request body' } });

    if (event.body.length > MAX_ENCODED_LENGTH)
        return HttpResponse({ statusCode: 413, body: { message: "File too large!" } })

    const buffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')
    if (!buffer.subarray(0, 5).toString('latin1').startsWith("%PDF"))
        return HttpResponse({ statusCode: 415, body: { message: "Invalid or corrupted pdf!" } })

    const rateLimitFailure = await withRateLimit(event)
    if (rateLimitFailure)
        return HttpResponse({
            statusCode: rateLimitFailure.statusCode,
            body: { message: rateLimitFailure.message }
        })

    let pdf;
    try {
        pdf = await getDocumentProxy(new Uint8Array(buffer))
        if (pdf.numPages > MAX_PDF_PAGES)
            return HttpResponse({ statusCode: 422, body: { message: "PDF cannot have more than 2 pages." } })

        const { text } = await extractText(pdf, { mergePages: true })

        if (!text.trim())
            return HttpResponse({ statusCode: 422, body: { message: "No readable text found!" } })
        if (text.length > MAX_EXTRACTED_TEXT_SIZE)
            return HttpResponse({ statusCode: 422, body: { message: "File content too large!" } })

        try {
            const installId = event.headers?.['x-install-id']
            if (typeof installId !== 'string' || !installId.trim())
                return HttpResponse({ statusCode: 400, body: { message: "A valid install ID is required" } })

            await registerInstall(installId.trim())
        } catch (error) {
            console.error('Install registration failed:', error.name, error.message)
            return HttpResponse({ statusCode: 500, body: { message: "Could not register this installation" } })
        }

        return HttpResponse({ statusCode: 200, body: { data: { text } } })

    } catch (error) {
        console.error('PDF parse failed:', error.message);
        return HttpResponse({ statusCode: 422, body: { message: 'Could not read this PDF' } });
    } finally {
        await pdf?.cleanup()
    }
} 
