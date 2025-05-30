import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import AWS from "aws-sdk";
import multer from "multer";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// AWS config
AWS.config.update({ region: process.env.AWS_REGION });
const s3 = new AWS.S3();
// Multer config for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  },
});
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

// Endpoint: upload image to S3
app.post("/upload-image", verifyAccessToken, upload.single('image'), (req: AuthenticatedRequest, res: Response): void => {
  if (!req.file) {
    res.status(400).send("Brak pliku do przesłania.");
    return;
  }

  // Generate unique filename
  const timestamp = Date.now();
  const userId = req.user?.sub || 'anonymous';
  const fileExtension = req.file.originalname.split('.').pop();
  const fileName = `images/${userId}/${timestamp}.${fileExtension}`;

  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: fileName,
    Body: req.file.buffer,
    ContentType: req.file.mimetype,
    ServerSideEncryption: 'AES256',
  };

  s3.upload(uploadParams, (err: any, data: { Location: any; ETag: any; }) => {
    if (err) {
      console.error('Upload error:', err);
      res.status(500).send("Błąd podczas przesyłania pliku.");
      return;
    }

    res.json({
      message: "Plik został przesłany pomyślnie.",
      key: fileName,
      location: data.Location,
      etag: data.ETag
    });
  });
});

app.delete("/delete-file", verifyAccessToken, (req: AuthenticatedRequest, res: Response): void => {
  const fileKey = req.query.key as string;
  if (!fileKey) {
    res.status(400).send("Brak parametru 'key'.");
    return;
  }

  // Optional: Check if user owns the file (security check)
  const userId = req.user?.sub;
  if (userId && !fileKey.startsWith(`images/${userId}/`)) {
    res.status(403).send("Brak uprawnień do usunięcia tego pliku.");
    return;
  }

  // First check if file exists
  const headParams = {
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: fileKey,
  };

  s3.headObject(headParams, (headErr: any, headData: any) => {
    if (headErr) {
      if (headErr.statusCode === 404) {
        res.status(404).json({
          message: "Plik nie istnieje.",
          key: fileKey,
          exists: false
        });
        return;
      } else {
        console.error('Head object error:', headErr);
        res.status(500).send("Błąd podczas sprawdzania pliku.");
        return;
      }
    }

    // File exists, proceed with deletion
    const deleteParams = {
      Bucket: process.env.S3_BUCKET_NAME!,
      Key: fileKey,
    };

    s3.deleteObject(deleteParams, (err: any, data: any) => {
      if (err) {
        console.error('Delete error:', err);
        res.status(500).send("Błąd podczas usuwania pliku.");
        return;
      }

      res.json({
        message: "Plik został usunięty pomyślnie.",
        key: fileKey,
        deleted: true
      });
    });
  });
});

app.get("/list-files", verifyAccessToken, (req: AuthenticatedRequest, res: Response): void => {
  const userId = req.user?.sub;
  if (!userId) {
    res.status(400).send("Nie można zidentyfikować użytkownika.");
    return;
  }

  const listParams = {
    Bucket: process.env.S3_BUCKET_NAME!,
    Prefix: `images/${userId}/`,
    MaxKeys: 1000, // Limit to 1000 files
  };

  s3.listObjectsV2(listParams, (err: any, data: any) => {
    if (err) {
      console.error('List objects error:', err);
      res.status(500).send("Błąd podczas pobierania listy plików.");
      return;
    }

    const files = data.Contents?.map((object: any) => ({
      key: object.Key,
      size: object.Size,
      lastModified: object.LastModified,
      etag: object.ETag,
      // Extract filename from key
      filename: object.Key.split('/').pop()
    })) || [];

    res.json({
      message: "Lista plików pobrana pomyślnie.",
      userId: userId,
      totalFiles: files.length,
      files: files
    });
  });
});

app.listen(port, () => {
  console.log(`✅ Serwer działa na http://localhost:${port}`);
});
