import { HttpResponse } from "../../utils/http-response.mjs"

export const handler = async (event) => {
    const method = event.requestContext.http.method;
    const path = event.rawPath

    if (method !== 'GET')
        return HttpResponse({ statusCode: 405, body: { message: 'Method not allowed' } });

    if (path === '/health')
        return HttpResponse({ statusCode: 200, body: { message: "Server running!" } })

    return HttpResponse({ statusCode: 404, body: { message: "Error. Not found!" } })
}