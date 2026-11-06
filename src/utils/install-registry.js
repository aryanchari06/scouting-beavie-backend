import dbClient from "./dynamo-db.js"
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb"

const TABLE_NAME = "beavie-installs"

export const registerInstall = async (installId) => {
    const now = new Date().toISOString()

    await dbClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: installId },
        UpdateExpression: "SET #createdAt = if_not_exists(#createdAt, :now), #lastSeenAt = :now",
        ExpressionAttributeNames: {
            "#createdAt": "createdAt",
            "#lastSeenAt": "lastSeenAt"
        },
        ExpressionAttributeValues: {
            ":now": now
        }
    }))
}

export const isRegisteredInstall = async (installId) => {
    const result = await dbClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: installId },
        ConsistentRead: true,
        ProjectionExpression: "#pk",
        ExpressionAttributeNames: { "#pk": "pk" }
    }))

    return Boolean(result.Item)
}
