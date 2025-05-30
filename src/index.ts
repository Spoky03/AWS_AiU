import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import AWS from "aws-sdk";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// AWS config
AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3();

// JWKS setup
const jwks = jwksClient({
  jwksUri: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  jwks.getSigningKey(header.kid as string, (err, key) => {
    if (err) return callback(err, undefined);
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

interface AuthenticatedRequest extends Request {
  user?: any;
}

// Middleware: weryfikacja access_token
function verifyAccessToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    res.status(401).send("Brak tokena.");
    return;
  }

  jwt.verify(
    token,
    getKey,
    {
      algorithms: ["RS256"],
      issuer: `https://cognito-idp.${process.env.AWS_REGION}.amazonaws.com/${process.env.COGNITO_USER_POOL_ID}`,
    },
    (err, decoded) => {
      if (err) {
        res.status(403).send("Nieprawidłowy token.");
        return;
      }
      req.user = decoded;
      next();
    }
  );
}

// Endpoint: generowanie URL do pobrania pliku z S3
app.get("/download-url", verifyAccessToken, (req: AuthenticatedRequest, res: Response): void => {
  const fileKey = req.query.key as string;
  if (!fileKey) {
    res.status(400).send("Brak parametru 'key'.");
    return;
  }

  const params = {
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: fileKey,
    Expires: 300, // 5 min
  };

  const url = s3.getSignedUrl("getObject", params);
  res.json({ url });
});

app.listen(port, () => {
  console.log(`✅ Serwer działa na http://localhost:${port}`);
});
