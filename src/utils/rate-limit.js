import dbClient from "./dynamo-db.js"
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb"

const allowedPaths = [
    { path: '/parse-pdf', endpoint: 'parse_pdf' },
    { path: '/match-job-profile', endpoint: 'match_job_profile' }
]
const byIp = (event) => event.requestContext?.http?.sourceIp
const byInstallId = (event) => {
    const installId = event.headers?.['x-install-id']
    return typeof installId === 'string' ? installId.trim() : installId
}

const formatKey = ({ scope, value, endpoint, date }) => `scope:${scope}::value:${value}::endpoint:${endpoint}#${date}`

const getMaxLimit = (path, scope) => {
    switch (path) {
        case "/match-job-profile": return scope === "installId" ? 3 : 10
        case "/parse-pdf": return scope === "installId" ? 10 : 50
        default: return 100
    }
}
const getCurrDate = () => new Date().toISOString().slice(0, 10)

const failure = (statusCode, code, message, retryable = false) => ({
    statusCode,
    code,
    message,
    retryable
})

const withRateLimit = async (event) => {
    try {
        const rawPath = event.rawPath
        const path = allowedPaths.find(p => p.path === rawPath)
        if (path === undefined)
            return failure(404, 'NOT_FOUND', 'Path not found!')

        const ip = byIp(event)
        const installId = byInstallId(event)
        if (typeof ip !== 'string' || !ip)
            return failure(500, 'CLIENT_IP_UNAVAILABLE', 'Unable to identify request source')
        if (typeof installId !== 'string' || !installId.trim() || installId.length > 128)
            return failure(400, 'INSTALL_ID_INVALID', 'A valid install ID is required')

        const date = getCurrDate()
        const exp = Math.floor(Date.now() / 1000) + 172800
        const ipKey = formatKey({ scope: 'ip', value: ip, endpoint: path.endpoint, date })
        const installIdKey = formatKey({ scope: 'installId', value: installId, endpoint: path.endpoint, date })

        const updates = [
            { pk: ipKey, limit: getMaxLimit(path.path, "ip") },
            { pk: installIdKey, limit: getMaxLimit(path.path, "installId") }
        ]

        try {
            await dbClient.send(new TransactWriteCommand({
                TransactItems: updates.map(({ pk, limit }) => ({
                    Update: {
                        TableName: "beavie-ratelimit",
                        Key: { pk },
                        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #exp = :exp",
                        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
                        ExpressionAttributeNames: { "#count": "count", "#exp": "expiresAt" },
                        ExpressionAttributeValues: {
                            ":zero": 0,
                            ":one": 1,
                            ":limit": limit,
                            ":exp": exp
                        }
                    }
                }))
            }))
        } catch (error) {
            const conditionFailed = error.name === 'TransactionCanceledException'
                && error.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed')
            if (conditionFailed)
                return failure(429, 'RATE_LIMIT_EXCEEDED', 'You have exhausted your quota for today. Try again tomorrow!')

            throw error
        }

        return null
    } catch (error) {
        console.error('Rate limit error:', error.name, error.message)
        return failure(500, 'RATE_LIMIT_ERROR', 'Unable to check request quota', true)
    }
}

export { withRateLimit }