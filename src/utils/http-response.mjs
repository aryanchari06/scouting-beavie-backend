const HttpResponse = ({ statusCode, headers, body }) => {
    const response = {
        statusCode,
        headers: {
            'content-type': 'application/json',
            // 'Access-Control-Allow-Origin': '*',
            ...headers
        },
        body: JSON.stringify(body)
    }
    return response
}

export { HttpResponse }