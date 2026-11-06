import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"

const client = new DynamoDBClient({ region: "ap-south-1" })
const dbClient = DynamoDBDocumentClient.from(client)

export default dbClient