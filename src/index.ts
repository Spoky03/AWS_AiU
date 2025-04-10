import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import AWS from "aws-sdk";

dotenv.config();

const app = express();
const port = 3000;

// AWS config
AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3();

// JWKS setup
const client = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  client.getSigningKey(header.kid as string, (err, key) => {
    if (err) return callback(err, undefined); // Use 'undefined' instead of 'null'
    const signingKey = key?.getPublicKey();
    if (!signingKey) return callback(new Error("Signing key is undefined"), undefined);
    callback(null, signingKey);
  });
}
interface AuthenticatedRequest extends Request {
  user?: any;
}

// JWT verify middleware
function verifyToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).send("Brak tokena.");

  jwt.verify(
    token,
    getKey,
    {
      audience: process.env.COGNITO_CLIENT_ID,
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
      algorithms: ["RS256"],
    },
    (err, decoded) => {
      if (err) return res.status(401).send("Token nieprawidłowy.");
      req.user = decoded;
      next();
    }
  );
}

// GET /generate-upload-url
app.get("/generate-upload-url", verifyToken, (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.sub;
  const fileName = req.query.filename as string;
  const fileType = req.query.type as string;

  if (!fileName || !fileType) {
    return res.status(400).send("Brak wymaganych parametrów.");
  }

  const params = {
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: `${userId}/${fileName}`,
    ContentType: fileType,
    Expires: 300,
  };

  const url = s3.getSignedUrl("putObject", params);
  res.json({ url });
});

app.listen(port, () => {
  console.log(`🚀 Serwer działa na http://localhost:${port}`);
});
